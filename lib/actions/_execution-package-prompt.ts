/**
 * Pure prompt-assembly helpers for the execution-package generators.
 *
 * This module holds every string-template, regex-parse, and topological-sort
 * helper that the monolithic and compartmentalized generators share. None of
 * the functions exported here perform I/O — they take fully-hydrated inputs
 * (fetched by the orchestrator in `execution-package.ts`) and return:
 *
 *   - LLM prompt bundles: { systemPrompt, userMessage, maxTokens }
 *   - Derived text blocks (source-tables, target-schema, mapping-sections)
 *   - Post-LLM SQL-parsing utilities (splitMonolithicSQL, sanitizeClaudeJson)
 *   - Topological load-order computation (computeLoadOrder)
 *
 * Why it exists: golden-output tests (`tests/outputs/execution-package-prompt.*`)
 * pin these prompt bundles against checked-in fixtures. Because every helper
 * here is pure, the tests feed in an in-memory scenario from
 * `tests/fixtures/outputs/seed.ts` and assert the result — no Supabase mocks,
 * no Claude calls, no storage writes. Any drift in prompt construction
 * against the new mapping data model fails CI.
 *
 * Data model note: this module's `buildMappingSections` consumes the new
 * model directly (target_field_mappings + mapping_sources, via the grouper
 * in `_outputs-helpers.ts`). The orchestrator in execution-package.ts
 * queries the new tables and passes the rows through verbatim. The former
 * `toLegacyTransformation` adapter was deleted in Prompt 3d Step 3D-12;
 * TransformationRow now flows end-to-end.
 */

import type { SqlDialect, CheckConstraint } from '@/lib/types/database'
import type {
  TargetFieldMappingRow,
  MappingSourceRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import { groupTfmsByTableMapping } from '@/lib/actions/_outputs-helpers'
import type {
  FieldLookupRow,
  TableMappingLookup,
  TfmForTm,
} from '@/lib/actions/_outputs-helpers'

// ─── Shared types ──────────────────────────────────────────────────────────

export interface TargetFieldRow {
  id: string
  table_id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  check_constraint: CheckConstraint | null
  ordinal_position: number
}

export interface SourceFieldRow {
  id: string
  table_id: string
  name: string
  data_type: string
  inferred_type?: string | null
  ordinal_position?: number
}

export interface TableRow {
  id: string
  dataset_id?: string
  name: string
  row_count: number | null
}

export interface QualityIssueRow {
  id: string
  severity: string
  status: string
  title: string
  description: string
  affected_records: number
  generated_sql: string | null
}

export interface ValidationRuleRow {
  id: string
  name: string
  description: string | null
  rule_type: string
  severity: string
  rule_config?: Record<string, unknown> | null
}

export interface SchemaDocRow {
  dataset_id: string | null
  project_id: string | null
  doc_type: string
  filename: string
  extracted_text: string | null
}

export interface LoadOrderEntry {
  tableName: string
  tableId: string
  dependencies: string[]
}

/**
 * Everything both prompt assemblers need. Hydrated once by the orchestrator
 * (`execution-package.ts :: fetchExecutionPackageContext`) and passed through
 * to the pure assemblers below.
 */
export interface ExecutionPackageContext {
  projectName: string
  sourceDatasetName: string | null
  targetDatasetName: string | null

  sourceTables: TableRow[]
  targetTables: TableRow[]

  sourceFields: SourceFieldRow[]
  targetFields: TargetFieldRow[]

  tableMappings: TableMappingLookup[]
  targetFieldMappings: TargetFieldMappingRow[]
  mappingSources: MappingSourceRow[]
  transformations: TransformationRow[]

  qualityIssues: QualityIssueRow[]
  validationRules: ValidationRuleRow[]
  schemaDocs: SchemaDocRow[]

  /**
   * ISO timestamp emitted into the prompt on the "Generated: …" line.
   * Variable at runtime but redacted by the golden-fixture assert helper
   * via the ISO-timestamp regex. Kept in the output verbatim because it's
   * customer-visible metadata in the final SQL file header.
   */
  generatedAt: string
}

export interface MonolithicPromptBundle {
  systemPrompt: string
  userMessage: string
  maxTokens: number
  /** Count of field mappings (primary TFMs, including VAs) covered by the
   *  prompt — surfaced in the SQL file header after Claude returns. */
  totalFieldMappings: number
  /** Count of transformation rules embedded in mapping sections. */
  totalTransformRules: number
  /** Topologically-sorted target tables, surfaced to the orchestrator for
   *  post-LLM splitting and file header stats. */
  loadOrder: LoadOrderEntry[]
}

export interface CompartmentalizedPromptBundle {
  systemPrompt: string
  userMessage: string
  maxTokens: number

  /**
   * Monolithic fallback prompt pre-computed here so the orchestrator can fire
   * it when dialect validation fails on Claude's JSON output. Building it
   * eagerly keeps the fallback path deterministic and fixture-testable — the
   * orchestrator just chooses whether to send it.
   */
  fallbackSystemPrompt: string
  fallbackUserMessage: string
  fallbackMaxTokens: number

  totalFieldMappings: number
  totalTransformRules: number
  loadOrder: LoadOrderEntry[]
}

// ─── System prompts ─────────────────────────────────────────────────────────

export const EXECUTION_PACKAGE_SYSTEM_PROMPT = `You are an expert data migration engineer generating a production-ready SQL migration execution package using a three-phase ETL pattern: Source → Staging → Target.

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

export const MONOLITHIC_FALLBACK_INSTRUCTIONS = `## Instructions
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

export const COMPARTMENTALIZED_SYSTEM_PROMPT = `You are an expert data migration engineer generating production-ready, compartmentalized SQL migration scripts using a three-phase ETL pattern: Source → Staging → Target.

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

// ─── Dialect instructions ───────────────────────────────────────────────────

export function getDialectInstructions(dialect: SqlDialect): string {
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

export function getTransformAdaptationInstruction(dialect: SqlDialect): string {
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

// ─── Formatters ─────────────────────────────────────────────────────────────

export function formatTargetFieldLine(f: TargetFieldRow): string {
  const flags: string[] = []
  if (!f.is_nullable) flags.push('NOT NULL')
  if (f.is_primary_key) flags.push('PK')
  if (f.is_foreign_key && f.fk_reference) flags.push(`FK→${f.fk_reference}`)
  if (f.check_constraint) {
    const cc = f.check_constraint
    if (cc.type === 'in_list' && cc.allowedValues?.length) {
      flags.push(`CHECK IN (${cc.allowedValues.join(', ')})`)
    } else if (cc.type === 'regex' && cc.pattern) {
      flags.push(`CHECK REGEX: ${cc.pattern}`)
    } else if (cc.type === 'range') {
      const parts: string[] = []
      if (cc.min !== undefined) parts.push(`>=${cc.min}`)
      if (cc.max !== undefined) parts.push(`<=${cc.max}`)
      if (parts.length > 0) flags.push(`CHECK RANGE ${parts.join(' ')}`)
    } else if (cc.raw) {
      flags.push(`CHECK(${cc.raw})`)
    }
  }
  return `  - ${f.name} ${f.data_type}${flags.length ? ' ' + flags.join(' ') : ''}`
}

export function formatValidationRuleLine(rule: ValidationRuleRow): string {
  let ruleDesc = `- [${rule.severity}] ${rule.name} (${rule.rule_type})`
  if (rule.description) ruleDesc += ` — ${rule.description}`
  if (rule.rule_config) {
    const cfg = rule.rule_config
    if (Array.isArray(cfg.values) && cfg.values.length > 0) {
      ruleDesc += ` Values: ${(cfg.values as unknown[]).map((v) => String(v)).join(', ')}`
    }
    if (typeof cfg.pattern === 'string' && cfg.pattern.length > 0) {
      ruleDesc += ` Pattern: ${cfg.pattern}`
    }
    if (cfg.min !== undefined || cfg.max !== undefined) {
      ruleDesc += ` Range: ${cfg.min ?? ''}..${cfg.max ?? ''}`
    }
    if (typeof cfg.fk_reference === 'string' && cfg.fk_reference.length > 0) {
      ruleDesc += ` FK→${cfg.fk_reference}`
    }
  }
  return ruleDesc
}

// ─── Topological load-order ─────────────────────────────────────────────────

/**
 * Topological sort of target tables based on FK references.
 * Tables that are referenced by others load first. Falls back to alphabetical
 * order when a circular dependency is detected.
 */
export function computeLoadOrder(
  targetTables: Array<{ id: string; name: string }>,
  targetFields: TargetFieldRow[],
): LoadOrderEntry[] {
  const tableNames = new Map(targetTables.map((t) => [t.id, t.name]))
  const tableByNameLower = new Map(targetTables.map((t) => [t.name.toLowerCase(), t.name]))

  const deps = new Map<string, Set<string>>()
  for (const t of targetTables) {
    deps.set(t.name, new Set())
  }

  for (const field of targetFields) {
    if (!field.is_foreign_key || !field.fk_reference) continue
    const ownerTable = tableNames.get(field.table_id)
    if (!ownerTable) continue

    const parts = field.fk_reference.split('.')
    const refTableRaw = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    const refTable = tableByNameLower.get(refTableRaw.toLowerCase())

    if (refTable && refTable !== ownerTable) {
      deps.get(ownerTable)?.add(refTable)
    }
  }

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const [table, tableDeps] of deps) {
    inDegree.set(table, tableDeps.size)
    for (const dep of tableDeps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(table)
    }
  }

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

// ─── Mapping section assembly (NEW MODEL) ──────────────────────────────────

interface MappingSectionStats {
  sections: string[]
  totalFieldMappings: number
  totalTransformRules: number
}

/**
 * Build the "## Approved Mappings" body of the user prompt against the new
 * mapping-redesign data model.
 *
 * Translation from legacy behaviour:
 *   - Legacy iterated field_mappings where is_contributing IS NULL OR FALSE
 *     (i.e., primary edges only) and emitted one line per primary. Transform
 *     SQL was attached to those lines from transformations.field_mapping_id.
 *   - New: iterate TFMs owned by each TM (via `groupTfmsByTableMapping`). One
 *     primary line per TFM (VA or mapped). Contributors (ordinal >= 1) are
 *     emitted as additional lines beneath the primary, matching the legacy
 *     output for concat-type mappings. Transform SQL attaches to the primary
 *     line via transformations.target_field_mapping_id.
 *
 * Output line shape is byte-identical to the pre-074 legacy behaviour for
 * equivalent input data. Golden-output fixtures in
 * `tests/fixtures/outputs/execution-package-prompt.*.expected.md` pin the
 * exact bytes.
 */
function buildMappingSections(ctx: ExecutionPackageContext): MappingSectionStats {
  const fieldsById = new Map<string, FieldLookupRow>()
  for (const f of ctx.sourceFields) {
    fieldsById.set(f.id, { id: f.id, table_id: f.table_id, ordinal_position: f.ordinal_position })
  }
  for (const f of ctx.targetFields) {
    fieldsById.set(f.id, { id: f.id, table_id: f.table_id, ordinal_position: f.ordinal_position })
  }

  const grouped = groupTfmsByTableMapping({
    tableMappings: ctx.tableMappings,
    targetFieldMappings: ctx.targetFieldMappings.filter((t) => t.status === 'approved'),
    mappingSources: ctx.mappingSources,
    fieldsById,
  })

  // transformations keyed by TFM (the new invariant guarantees ≤ 1 per TFM,
  // so the defensive rank-based pick here is a harmless carry-over from the
  // legacy multi-row implementation).
  const txByTfm = new Map<string, TransformationRow>()
  for (const tr of ctx.transformations) {
    const existing = txByTfm.get(tr.target_field_mapping_id)
    const rank = (s: string) => ({ applied: 4, tested: 3, saved: 2, draft: 1 })[s] ?? 0
    if (!existing || rank(tr.status) > rank(existing.status)) {
      txByTfm.set(tr.target_field_mapping_id, tr)
    }
  }

  const sourceFieldMap = new Map(ctx.sourceFields.map((f) => [f.id, f]))
  const targetFieldMap = new Map(ctx.targetFields.map((f) => [f.id, f]))
  const sourceTableMap = new Map(ctx.sourceTables.map((t) => [t.id, t]))
  const targetTableMap = new Map(ctx.targetTables.map((t) => [t.id, t]))

  const sections: string[] = []
  let totalFieldMappings = 0
  let totalTransformRules = 0

  for (const tm of ctx.tableMappings) {
    const srcTable = sourceTableMap.get(tm.source_table_id)
    const tgtTable = targetTableMap.get(tm.target_table_id)
    if (!srcTable || !tgtTable) continue

    const entries = grouped.get(tm.id) ?? []
    const fieldLines: string[] = []

    for (const entry of entries) {
      totalFieldMappings++ // counts primary edges (matches legacy is_contributing=false count)

      const { tfm, primarySource, contributors } = entry
      const tgtField = targetFieldMap.get(tfm.target_field_id)
      if (!tgtField) continue

      const isVA = primarySource === null
      const srcField = primarySource?.source_field_id ? sourceFieldMap.get(primarySource.source_field_id) : null
      if (!isVA && !srcField) continue

      // Confidence is stored as 0-100 integer in target_field_mappings
      // and mapping_sources. Legacy formatter did Math.round(c * 100)
      // under the incorrect assumption that c was a 0-1 fraction,
      // producing absurd values like "9500%" in Claude prompts and
      // customer-facing execution packages. Fixed in Prompt 3c
      // (2026-04-22) — we now render the stored integer directly.
      const conf = tfm.confidence != null ? ` [confidence: ${Math.round(tfm.confidence)}%]` : ''

      let primaryLine = isVA
        ? `  - [Value Assignment] → ${tgtField.name} (${tgtField.data_type})`
        : `  - ${srcField!.name} (${srcField!.data_type}) → ${tgtField.name} (${tgtField.data_type})${conf}`

      const transform = txByTfm.get(tfm.id)
      if (transform?.generated_sql) {
        totalTransformRules++
        primaryLine += `\n    Transform SQL: ${transform.generated_sql.replace(/\n/g, ' ')}`
        if (transform.description) {
          primaryLine += `\n    Description: ${transform.description}`
        }
      } else if (isVA) {
        primaryLine += `\n    ⚠ No value expression defined yet`
      } else if (tfm.needs_transformation) {
        primaryLine += `\n    ⚠ Needs transformation (no SQL defined yet)`
      }

      fieldLines.push(primaryLine)

      // Contributor lines — one per contributor MS row, matching legacy
      // is_contributing=true behaviour. Contributors have no transform SQL;
      // they're consumed by the primary's transform via wrapFieldRefsInJsonb
      // at the execute_gold_standard_query site. Confidence here is the
      // contributor MS's own score (legacy surfaced field_mappings.confidence
      // on the contributor row for the same reason).
      for (const ms of contributors) {
        totalFieldMappings++ // legacy `fms.length` counted contributor rows too
        const contribField = ms.source_field_id ? sourceFieldMap.get(ms.source_field_id) : null
        if (!contribField) continue
        // Confidence is stored as 0-100 integer in target_field_mappings
        // and mapping_sources. Legacy formatter did Math.round(c * 100)
        // under the incorrect assumption that c was a 0-1 fraction,
        // producing absurd values like "9500%" in Claude prompts and
        // customer-facing execution packages. Fixed in Prompt 3c
        // (2026-04-22) — we now render the stored integer directly.
        const contribConf = ms.confidence != null ? ` [confidence: ${Math.round(ms.confidence)}%]` : ''
        fieldLines.push(
          `  - ${contribField.name} (${contribField.data_type}) → ${tgtField.name} (${tgtField.data_type})${contribConf}`,
        )
      }
    }

    sections.push(
      `### ${srcTable.name} → ${tgtTable.name}\n${fieldLines.join('\n') || '  (no approved field mappings)'}`,
    )
  }

  return { sections, totalFieldMappings, totalTransformRules }
}

// ─── Text-block helpers ─────────────────────────────────────────────────────

function buildSourceTablesText(ctx: ExecutionPackageContext): string {
  const sourceFieldsByTable = new Map<string, SourceFieldRow[]>()
  for (const f of ctx.sourceFields) {
    const list = sourceFieldsByTable.get(f.table_id) ?? []
    list.push(f)
    sourceFieldsByTable.set(f.table_id, list)
  }
  return (
    ctx.sourceTables
      .map((t) => {
        const tfields = sourceFieldsByTable.get(t.id) ?? []
        const fieldNames = tfields.map((f) => f.name).join(', ')
        return `- ${t.name}: ${(t.row_count ?? 0).toLocaleString()} rows${fieldNames ? `, fields: ${fieldNames}` : ''}`
      })
      .join('\n') || '  (no source tables)'
  )
}

function buildTargetSchemaLines(ctx: ExecutionPackageContext, loadOrder: LoadOrderEntry[]): string {
  const targetFieldsByTable = new Map<string, TargetFieldRow[]>()
  for (const f of ctx.targetFields) {
    const list = targetFieldsByTable.get(f.table_id) ?? []
    list.push(f)
    targetFieldsByTable.set(f.table_id, list)
  }
  const lines: string[] = []
  for (const entry of loadOrder) {
    const tgtTable = ctx.targetTables.find((t) => t.name === entry.tableName)
    if (!tgtTable) continue
    const tfields = targetFieldsByTable.get(tgtTable.id) ?? []
    lines.push(`### ${entry.tableName}`)
    lines.push('Fields:')
    for (const f of tfields) {
      lines.push(formatTargetFieldLine(f))
    }
  }
  return lines.join('\n')
}

function buildLoadOrderText(loadOrder: LoadOrderEntry[]): string {
  return (
    loadOrder
      .map((entry, i) => {
        const depNote = entry.dependencies.length > 0
          ? ` (depends on: ${entry.dependencies.join(', ')})`
          : ' (no dependencies)'
        return `${i + 1}. ${entry.tableName}${depNote}`
      })
      .join('\n') || '  (no target tables)'
  )
}

function buildDocBlock(ctx: ExecutionPackageContext): string {
  const sourceDsName = ctx.sourceDatasetName
  const targetDsName = ctx.targetDatasetName
  // Schema docs carry dataset_id; the orchestrator populates that. Fall back
  // to matching by dataset name ONLY if id-side matching finds nothing —
  // schema_documents in production always have dataset_id set.
  const sourceDocs = ctx.schemaDocs.filter(
    (d) => d.doc_type === 'schema' && d.extracted_text &&
      (sourceDsName == null ? false : ctx.sourceTables.some((t) => t.dataset_id && t.dataset_id === d.dataset_id)),
  )
  const targetDocs = ctx.schemaDocs.filter(
    (d) => d.doc_type === 'schema' && d.extracted_text &&
      (targetDsName == null ? false : ctx.targetTables.some((t) => t.dataset_id && t.dataset_id === d.dataset_id)),
  )
  const bizDocs = ctx.schemaDocs.filter((d) => d.doc_type === 'business_context' && d.extracted_text)

  const allParts: string[] = []
  for (const doc of [...sourceDocs, ...targetDocs, ...bizDocs]) {
    allParts.push(`--- ${doc.filename} (${doc.doc_type}) ---\n${(doc.extracted_text as string).slice(0, 12000)}`)
  }
  return allParts.length > 0 ? `<documentation>\n${allParts.join('\n\n')}\n</documentation>` : ''
}

function buildQualityText(ctx: ExecutionPackageContext, blockingHintDialect: 'legacy' | 'adapt'): {
  blockingText: string
  acceptedText: string
  validationText: string
  openBlockingCount: number
  openWarningCount: number
  fixedCount: number
  acceptedCount: number
} {
  const openBlocking = ctx.qualityIssues.filter((q) => q.severity === 'blocking' && q.status === 'open')
  const openWarnings = ctx.qualityIssues.filter((q) => q.severity === 'warning' && q.status === 'open')
  const fixedIssues = ctx.qualityIssues.filter((q) => q.status === 'fixed')
  const acceptedRisks = ctx.qualityIssues.filter((q) => q.status === 'accepted_risk')

  const fixHint = blockingHintDialect === 'adapt'
    ? 'Fix SQL (PostgreSQL syntax — adapt to target dialect): '
    : 'Fix SQL (available, not yet applied): '

  const blockingText = openBlocking.length > 0
    ? openBlocking
        .map((q) => {
          let line = `- [BLOCKING] ${q.title}: ${q.description} (${q.affected_records} records)`
          if (q.generated_sql) {
            line += `\n  ${fixHint}${q.generated_sql.replace(/\n/g, ' ')}`
          }
          return line
        })
        .join('\n')
    : '  None.'

  const acceptedText = acceptedRisks.length > 0
    ? acceptedRisks.map((q) => `- ${q.title}: ${q.description} (${q.affected_records} records) — ACCEPTED`).join('\n')
    : '  None.'

  const validationText = ctx.validationRules.length > 0
    ? ctx.validationRules.map((r) => formatValidationRuleLine(r)).join('\n')
    : '  None.'

  return {
    blockingText,
    acceptedText,
    validationText,
    openBlockingCount: openBlocking.length,
    openWarningCount: openWarnings.length,
    fixedCount: fixedIssues.length,
    acceptedCount: acceptedRisks.length,
  }
}

// ─── Public assemblers ──────────────────────────────────────────────────────

export function assembleMonolithicPrompt(
  ctx: ExecutionPackageContext,
  dialect: SqlDialect,
): MonolithicPromptBundle {
  const loadOrder = computeLoadOrder(
    ctx.targetTables.map((t) => ({ id: t.id, name: t.name })),
    ctx.targetFields,
  )

  const { sections, totalFieldMappings, totalTransformRules } = buildMappingSections(ctx)
  const sourceTablesText = buildSourceTablesText(ctx)
  const targetSchemaText = buildTargetSchemaLines(ctx, loadOrder)
  const loadOrderText = buildLoadOrderText(loadOrder)
  const docBlock = buildDocBlock(ctx)
  const { blockingText, acceptedText, validationText, openBlockingCount, openWarningCount, fixedCount, acceptedCount } =
    buildQualityText(ctx, 'legacy')

  const userMessage = `## Project
Migration: ${ctx.sourceDatasetName ?? 'Unknown'} → ${ctx.targetDatasetName ?? 'Unknown'}
Project: ${ctx.projectName}
Generated: ${ctx.generatedAt}

## Source Tables
${sourceTablesText}

## Target Schema
${targetSchemaText}

## Approved Mappings
${sections.join('\n\n') || '(no approved table mappings)'}

## Reference Documentation
The following documents provide business context, naming conventions, and domain knowledge.
If they describe different data types, constraints, or nullability than the Target Schema above, follow the Target Schema — it reflects the user's latest configuration.

${docBlock || '(no documentation uploaded)'}

## Data Quality Summary
- Open blocking issues: ${openBlockingCount}
- Open warnings: ${openWarningCount}
- Fixed issues: ${fixedCount}
- Accepted risks: ${acceptedCount}
- Active validation rules: ${ctx.validationRules.length}

### Open Blocking Issues
${blockingText}

### Accepted Risks
${acceptedText}

### Active Validation Rules
Use each rule's values/pattern/range verbatim when emitting CHECK / guard SQL. Blocking rules violated by staged rows must halt promotion.
${validationText}

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

  const systemPrompt =
    EXECUTION_PACKAGE_SYSTEM_PROMPT + '\n\n' + getDialectInstructions(dialect) + getTransformAdaptationInstruction(dialect)

  return {
    systemPrompt,
    userMessage,
    maxTokens: 16000,
    totalFieldMappings,
    totalTransformRules,
    loadOrder,
  }
}

export function assembleCompartmentalizedPrompt(
  ctx: ExecutionPackageContext,
  dialect: SqlDialect,
): CompartmentalizedPromptBundle {
  const loadOrder = computeLoadOrder(
    ctx.targetTables.map((t) => ({ id: t.id, name: t.name })),
    ctx.targetFields,
  )

  const { sections, totalFieldMappings, totalTransformRules } = buildMappingSections(ctx)
  const sourceTablesText = buildSourceTablesText(ctx)
  const targetSchemaText = buildTargetSchemaLines(ctx, loadOrder)
  const loadOrderText = buildLoadOrderText(loadOrder)
  const docBlock = buildDocBlock(ctx)
  const { blockingText, acceptedText, validationText, openBlockingCount, openWarningCount, fixedCount, acceptedCount } =
    buildQualityText(ctx, 'adapt')

  const dialectLabel = dialect === 'tsql' ? 'T-SQL (MS SQL Server)' : dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'
  const identifierStyle = dialect === 'tsql' ? '[bracket] identifiers' : dialect === 'mysql' ? 'backtick identifiers' : 'double-quote identifiers'

  const userMessage = `## Project
Migration: ${ctx.sourceDatasetName ?? 'Unknown'} → ${ctx.targetDatasetName ?? 'Unknown'}
Project: ${ctx.projectName}
Generated: ${ctx.generatedAt}

## Source Tables
${sourceTablesText}

## Target Schema
${targetSchemaText}

## Approved Mappings
${sections.join('\n\n') || '(no approved table mappings)'}

## Reference Documentation
The following documents provide business context, naming conventions, and domain knowledge.
If they describe different data types, constraints, or nullability than the Target Schema above, follow the Target Schema — it reflects the user's latest configuration.

${docBlock || '(no documentation uploaded)'}

## Data Quality Summary
- Open blocking issues: ${openBlockingCount}
- Open warnings: ${openWarningCount}
- Fixed issues: ${fixedCount}
- Accepted risks: ${acceptedCount}
- Active validation rules: ${ctx.validationRules.length}

### Open Blocking Issues
${blockingText}

### Accepted Risks
${acceptedText}

### Active Validation Rules
Use each rule's values/pattern/range verbatim when emitting CHECK / guard SQL. Blocking rules violated by staged rows must halt promotion.
${validationText}

## Load Order (FK-dependency resolved)
${loadOrderText}

## Total Counts
${ctx.tableMappings.length} approved table mappings, ${totalFieldMappings} field mappings, ${totalTransformRules} transformation rules.

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

  const systemPrompt =
    COMPARTMENTALIZED_SYSTEM_PROMPT + '\n\n' + getDialectInstructions(dialect) + getTransformAdaptationInstruction(dialect)

  // Fallback: reuse the userMessage sans the compartmentalized "## Instructions"
  // block, append the 6-section monolithic instructions.
  const instructionIdx = userMessage.indexOf('## Instructions')
  const baseMessage = instructionIdx !== -1 ? userMessage.slice(0, instructionIdx) : userMessage
  const fallbackUserMessage = baseMessage + MONOLITHIC_FALLBACK_INSTRUCTIONS
  const fallbackSystemPrompt =
    EXECUTION_PACKAGE_SYSTEM_PROMPT + '\n\n' + getDialectInstructions(dialect) + getTransformAdaptationInstruction(dialect)

  return {
    systemPrompt,
    userMessage,
    maxTokens: 64000,
    fallbackSystemPrompt,
    fallbackUserMessage,
    fallbackMaxTokens: 16000,
    totalFieldMappings,
    totalTransformRules,
    loadOrder,
  }
}

// ─── Post-LLM utilities (unchanged from legacy) ─────────────────────────────

/**
 * Returns true if the SQL content appears to use the expected dialect's
 * identifier style. Used to validate Claude's compartmentalized output before
 * accepting it.
 */
export function detectDialect(content: string, expected: SqlDialect): boolean {
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
  return (hasDoubleQuotes || hasPgCast) && !hasBrackets && !hasBackticks
}

/**
 * Sanitize Claude's JSON response to fix unescaped characters inside string values.
 * See inline comments for strategy.
 */
export function sanitizeClaudeJson(raw: string): string {
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
export function splitMonolithicSQL(
  sql: string,
  loadOrder: LoadOrderEntry[],
): { checklist: string; tableSections: Map<string, string>; validation: string; promote: string; rollback: string } {
  const tableSections = new Map<string, string>()

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

  for (let i = 0; i < loadOrder.length; i++) {
    const tableName = loadOrder[i].tableName
    const nextTableName = i + 1 < loadOrder.length ? loadOrder[i + 1].tableName : null

    const esc = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const insertRe = new RegExp(
      `INSERT\\s+INTO\\s+(?:\\[STG_${esc}\\]|\`STG_${esc}\`|"STG_${esc}"|STG_${esc})(?:\\s|\\()`,
      'i',
    )
    const insertMatch = insertRe.exec(sec3)
    if (!insertMatch) {
      tableSections.set(tableName, `-- No staging script found for STG_${tableName} in fallback generation.\n`)
      continue
    }

    const beforeInsert = sec3.slice(0, insertMatch.index)
    const lastCommentIdx = beforeInsert.lastIndexOf('\n--')
    const tableStart = lastCommentIdx > 0 ? lastCommentIdx + 1 : insertMatch.index

    let tableEnd = sec3.length
    if (nextTableName) {
      const escNext = nextTableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const nextInsertRe = new RegExp(
        `INSERT\\s+INTO\\s+(?:\\[STG_${escNext}\\]|\`STG_${escNext}\`|"STG_${escNext}"|STG_${escNext})(?:\\s|\\()`,
        'i',
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

// Re-export the grouping types for orchestrator convenience.
export type { FieldLookupRow, TableMappingLookup, TfmForTm }
