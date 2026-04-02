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
  type: 'checklist' | 'table_script' | 'validation' | 'rollback'
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

const EXECUTION_PACKAGE_SYSTEM_PROMPT = `You are an expert data migration engineer generating a production-ready SQL migration execution package.

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

SECTION 3 SPECIFIC RULES:
- Generate complete INSERT INTO target_table (col1, col2, ...) SELECT expr1, expr2, ... FROM source_table WHERE ... statements.
- Each target table gets its own INSERT...SELECT block.
- Order the blocks by the FK-dependency load order provided.
- Align column expressions vertically for readability.
- Add a blank line between each column expression for visual clarity.
- Include a -- comment above each expression naming the source→target field mapping.

SECTION 4 SPECIFIC RULES:
- For record count reconciliation, use independent COUNT queries (one for source with filters, one for target), presented side by side. Do NOT use JOINed reconciliation.
- For aggregate reconciliation (sums of amounts), use independent SUM queries on source vs target. Do NOT join source and target rows for comparison — this is fragile and error-prone.
- For FK integrity checks, use LEFT JOIN ... WHERE parent.pk IS NULL pattern.
- For CHECK constraint validation, use WHERE column NOT IN (...allowed values...) pattern.`

// ── Compartmentalized system prompt ───────────────────────────────────────────

const COMPARTMENTALIZED_SYSTEM_PROMPT = `You are an expert data migration engineer generating production-ready, compartmentalized SQL migration scripts.

OUTPUT FORMAT: Return ONLY a valid JSON object — no markdown fences, no preamble, no explanation outside the JSON.

JSON STRUCTURE:
{
  "files": [
    {
      "filename": "00_pre_migration_checklist.sql",
      "type": "checklist",
      "content": "-- PRE-MIGRATION CHECKLIST\\n..."
    },
    {
      "filename": "TABLE_PLACEHOLDER",
      "type": "table_script",
      "table_name": "ACTUAL_TABLE_NAME",
      "content": "-- SECTION A: EXTRACT QUERY\\n...\\n-- SECTION B: TRANSFORM & LOAD\\n...\\n-- SECTION C: TABLE VALIDATION\\n...\\n-- SECTION D: TABLE ROLLBACK\\n..."
    },
    {
      "filename": "VALIDATION_PLACEHOLDER",
      "type": "validation",
      "content": "-- POST-LOAD VALIDATION\\n..."
    },
    {
      "filename": "99_full_rollback.sql",
      "type": "rollback",
      "content": "-- FULL ROLLBACK\\n..."
    }
  ]
}

FILE NUMBERING: Use placeholder filenames for table scripts and the validation file — the caller assigns the numeric prefix (01_, 02_, etc.) based on FK dependency order. Use "00_pre_migration_checklist.sql" and "99_full_rollback.sql" as-is.

SQL FORMATTING RULES:
- Format all SQL with proper indentation and line breaks.
- Each CASE WHEN clause on its own indented line.
- Maximum line width: 100 characters.
- Use clear section headers as SQL block comments with === separator lines.
- Each file must be completely self-contained and independently executable.
- Do NOT reference variables, temp tables, or state from other files.

FILE 1 — Pre-Migration Checklist (00_pre_migration_checklist.sql):
- SQL comments ONLY — no executable SQL.
- List all open blocking issues with severity and record counts.
- Include fix SQL for each issue as commented-out SQL (ready to uncomment and run).
- List accepted risks with notes.
- Show source record counts per table.
- Check every NOT NULL target field: if any mapping could produce NULL for that field, flag it here.

FILE 2..N — Per-Table Scripts (one per target table, in FK dependency order provided):
Each table file has FOUR sections:

SECTION A — EXTRACT QUERY
- The SELECT query to extract source data for this table.
- Apply all business-rule filters (status exclusions, null PK exclusion).
- For child tables: include WHERE parent_fk IN (SELECT pk FROM parent WHERE <same parent filters>).
- Add a comment above each WHERE clause explaining the filter.

SECTION B — TRANSFORM & LOAD
- A complete INSERT INTO target_table (cols) SELECT exprs FROM source WHERE <filters>.
- Use the EXACT approved transformation SQL verbatim for fields that have it.
- For fields without transform SQL: generate appropriate type casting or direct mapping.
- For NOT NULL target fields where source can be NULL: use COALESCE with a sensible default.
- Format each column expression on its own line with a comment.

SECTION C — TABLE VALIDATION
- Row count check: two independent SELECT COUNT(*) queries — one on source (same filters as Section B), one on target.
- Sample spot-check: SELECT the first 5 rows from the target table (LIMIT 5 / TOP 5 per dialect).

SECTION D — TABLE ROLLBACK
- A DELETE FROM [target_table] statement.
- Scope to only rows loaded by this script if a reliable WHERE clause exists (e.g., WHERE pk IN (SELECT pk FROM source WHERE ...)).
- If no reliable scoping exists: DELETE FROM [target_table] — with a prominent comment warning this deletes ALL rows.

FILE N+1 — Post-Load Validation (numbered after last table):
- Cross-table record count reconciliation: SELECT COUNT(*) source vs target for every table.
- FK integrity checks: LEFT JOIN parent WHERE parent.pk IS NULL pattern for every FK relationship.
- CHECK constraint validation: WHERE field NOT IN (...) pattern for every picklist field.
- NOT NULL checks: SELECT COUNT(*) WHERE field IS NULL for every NOT NULL target field.
- Aggregate reconciliation: independent SUM queries for key numeric fields.

FILE 99 — Full Rollback (99_full_rollback.sql):
- DELETE FROM statements for ALL target tables in REVERSE FK dependency order (children first, then parents).
- Each DELETE on its own line with a comment identifying the table.
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

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) return { success: false, error: rateLimit.error ?? 'Rate limit exceeded' }

    const { data: project } = await supabase
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .eq('user_id', user.id)
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
Generate a SQL migration execution package with exactly 5 sections:

SECTION 1 — PRE-MIGRATION CHECKLIST
- List all open blocking issues as SQL comments with severity and record counts.
- Include fix SQL for each issue if available (commented out with -- prefix, ready to uncomment and run).
- List all accepted risks as comments.
- Include a comment block with total source record counts per table.
- CRITICAL: Check every NOT NULL target field. If any source mapping or transformation could produce NULL for a NOT NULL target field, flag it here as a blocking issue with the specific field name and estimated affected row count.

SECTION 2 — EXTRACT QUERIES
- One SELECT query per source table.
- Apply filtering rules from the business rules documentation (e.g., status exclusions like excluding Archived records).
- Include WHERE clauses that exclude records with null or empty primary keys.
- DO NOT apply date-range or numeric-range filters here if the source field is VARCHAR — those filters belong in Section 3 after type conversion.
- For child tables, include a WHERE clause that filters to only records whose FK exists in the parent table AFTER the parent's own filters are applied. Example: WHERE customer_id IN (SELECT customer_id FROM Customers WHERE customer_id IS NOT NULL AND status != 'Archived')
- Add a comment above each WHERE clause explaining the filter criterion and which business rule it implements.

SECTION 3 — TRANSFORMATION & LOAD SCRIPTS
- Generate scripts in the load order specified above.
- For EACH target table, generate a complete:
    INSERT INTO target_table (col1, col2, ...)
    SELECT
        -- source_field → target_field: description
        transform_expression AS col1,

        -- source_field → target_field: description
        transform_expression AS col2,
        ...
    FROM source_table
    WHERE <filters>;
- Use the EXACT approved transformation SQL for fields that have it — embed verbatim.
- For fields without explicit transforms, generate appropriate type casting or direct mapping.
- For NOT NULL target fields where the source can be NULL, use COALESCE with a sensible default.
- For unmapped target fields that have database DEFAULT values, omit them from the INSERT column list (let the database apply the default).
- Apply all filtering: null PK exclusion, business rule exclusions, parent-table existence checks for child tables.
- Date-range filters (e.g., close_date >= '2020-01-01') MUST be applied AFTER date parsing/conversion, not on the raw VARCHAR. Use a subquery or CTE if needed.
- Format each column expression on its own line with a descriptive comment.

SECTION 4 — POST-LOAD VALIDATION
Generate these validation queries:
- Record count reconciliation: For each table mapping, generate TWO independent queries side by side:
    SELECT 'Source: table_name' AS label, COUNT(*) AS row_count FROM source_table WHERE <same filters as Section 3>;
    SELECT 'Target: table_name' AS label, COUNT(*) AS row_count FROM target_table;
- FK integrity checks: For every FK relationship in the target schema:
    SELECT 'Orphaned records in child_table.fk_field' AS check_name, COUNT(*) AS violations FROM child_table c LEFT JOIN parent_table p ON c.fk = p.pk WHERE p.pk IS NULL;
- CHECK constraint validation: For every picklist/code field with a CHECK constraint:
    SELECT 'Invalid values in table.field' AS check_name, field_name, COUNT(*) AS violations FROM table WHERE field NOT IN ('val1', 'val2', ...) GROUP BY field_name;
- NOT NULL checks: For every NOT NULL target field:
    SELECT 'NULL violations in table.field' AS check_name, COUNT(*) AS violations FROM table WHERE field IS NULL;
- Aggregate reconciliation: For key numeric fields (amounts, revenues), generate independent SUM queries:
    SELECT 'Source total: field' AS label, SUM(cleaned_expression) AS total FROM source_table WHERE <filters>;
    SELECT 'Target total: field' AS label, SUM(field) AS total FROM target_table;

SECTION 5 — ROLLBACK
- Generate DELETE FROM statements for each target table in REVERSE load order (to respect FK constraints).
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
    // ── 1. Auth + ownership ──────────────────────────────────────────────────

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) return { success: false, error: rateLimit.error ?? 'Rate limit exceeded' }

    const { data: project } = await supabase
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .eq('user_id', user.id)
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
Generate the compartmentalized migration scripts following the system prompt rules exactly.
Return one entry per target table (in the load order listed above, using the table names exactly as listed).
The "files" array must contain entries in this order:
1. Pre-migration checklist (type: "checklist")
2. One entry per target table in the order listed above (type: "table_script") — use the exact table name in "table_name"
3. Post-load validation (type: "validation")
4. Full rollback (type: "rollback")`

    // ── Call Claude ───────────────────────────────────────────────────────────

    const dialectSystemPrompt = COMPARTMENTALIZED_SYSTEM_PROMPT
      + '\n\n'
      + getDialectInstructions(dialect)
      + getTransformAdaptationInstruction(dialect)

    let rawResponse: string
    try {
      // Must use streaming — the Anthropic SDK refuses non-streaming calls when max_tokens is
      // large enough that estimated generation time could exceed 10 minutes.
      // 32000 tokens gives enough budget for 6-10 tables of JSON-wrapped SQL.
      rawResponse = await callClaudeStreaming(dialectSystemPrompt, userMessage, 32000)
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

      const parsed = JSON.parse(cleaned) as { files: ClaudeFileEntry[] }
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
      assembledFiles.push({ ...f, assignedFilename: `${num}_${safeName}_load.sql` })
    })

    const validationNum = String(orderedTableFiles.length + 1).padStart(2, '0')
    if (validation) {
      assembledFiles.push({ ...validation, assignedFilename: `${validationNum}_post_load_validation.sql` })
    }

    if (rollback) {
      assembledFiles.push({ ...rollback, assignedFilename: '99_full_rollback.sql' })
    }

    if (assembledFiles.length === 0) {
      return { success: false, error: 'No files were generated. Please try again.' }
    }

    // ── Upload to storage ─────────────────────────────────────────────────────

    const version = await getNextVersionStr(projectId, 'execution_package', 'per_table')
    const versionFolder = `${user.id}/${projectId}/outputs/execution-package-v${version}_${dialect}`

    const uploadedFiles: CompartmentalizedFile[] = []

    for (const f of assembledFiles) {
      const storagePath = `${versionFolder}/${f.assignedFilename}`
      await supabaseAdmin.storage.from('project-files').upload(
        storagePath,
        Buffer.from(f.content, 'utf-8'),
        { contentType: 'text/plain; charset=utf-8', upsert: true }
      )
      uploadedFiles.push({
        filename: f.assignedFilename,
        type: f.type as CompartmentalizedFile['type'],
        content: f.content,
        table_name: f.table_name,
        load_order: f.type === 'table_script' ? orderedTableFiles.indexOf(f) + 1 : undefined,
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
    .eq('user_id', user.id)
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
    .eq('user_id', user.id)
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
