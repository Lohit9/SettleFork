'use server'

/**
 * Execution-package generators (monolithic SQL + compartmentalized per-table).
 *
 * =========================================================================
 * DATA MODEL
 * =========================================================================
 * Reads the NEW mapping-redesign schema introduced in migration 074 + 075:
 *
 *   - public.target_field_mappings (TFM)
 *   - public.mapping_sources (MS, ordinal=0 = primary; 1..N = contributors)
 *   - public.transformations (now keyed by target_field_mapping_id)
 *
 * Translation to prompt text is handled by the pure helpers in
 * `_execution-package-prompt.ts`; this file only orchestrates data fetching,
 * Claude calls, storage uploads, and outputs-table persistence.
 *
 * =========================================================================
 * MAINTENANCE-MODE GUARD — DELIBERATELY NOT WIRED HERE
 * =========================================================================
 * `assertMappingWritesEnabled()` gates MAPPING writes (TFM / MS / source_acks).
 * Execution-package generation is a READ of those tables plus a WRITE to the
 * `outputs` artifact store. Customer downloads must continue to work during
 * maintenance windows — a founder toggling `maintenance_mode` for a mapping
 * data bug should not silently break every customer's existing migration
 * package download. Do NOT "helpfully" add the guard here. This non-wiring
 * is intentional (Prompt 3c design decision D8).
 *
 * =========================================================================
 * INTERNAL vs EXPORTED FUNCTIONS (Refinement 3)
 * =========================================================================
 * The actual work lives in non-exported `*Internal` functions that accept an
 * `opts.__skipPersistence` flag. Exported server actions are thin wrappers
 * that call Internal with `__skipPersistence: false`. This ensures the flag
 * can NEVER be flipped by a UI or route-handler caller — it exists solely
 * for test paths that exercise generation logic without mutating the
 * `outputs` table or storage bucket.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callLLM, callLLMStreaming } from '@/lib/ai/llm-client'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import JSZip from 'jszip'
import type { SqlDialect, ExecutionPackageFormat } from '@/lib/types/database'
import type {
  TargetFieldMappingRow,
  MappingSourceRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import {
  type ExecutionPackageContext,
  type LoadOrderEntry,
  type TargetFieldRow,
  type SourceFieldRow,
  type TableRow,
  type QualityIssueRow,
  type ValidationRuleRow,
  type SchemaDocRow,
  assembleMonolithicPrompt,
  assembleCompartmentalizedPrompt,
  detectDialect,
  sanitizeClaudeJson,
  splitMonolithicSQL,
} from '@/lib/actions/_execution-package-prompt'

// ─── Public result types ────────────────────────────────────────────────────

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

// ─── Internal-only options (Refinement 3) ──────────────────────────────────

/**
 * Options that `*Internal` functions accept but exported server actions
 * never forward. The `__skipPersistence` double-underscore prefix marks this
 * as internal-use-only — do not expose via any exported signature.
 *
 * Test use: integration-test harnesses set `__skipPersistence: true` to
 * exercise prompt construction and (optionally) the Claude call without
 * polluting the `outputs` table or storage bucket. Tests that only need
 * to verify prompt bytes should NOT even invoke Internal — they should
 * build an `ExecutionPackageContext` directly and call the pure assemblers
 * in `_execution-package-prompt.ts`.
 */
interface InternalOpts {
  __skipPersistence: boolean
}

// ─── Context fetch (new data model) ─────────────────────────────────────────

/**
 * Fetch everything the pure prompt assemblers need, against the new
 * mapping-redesign tables. Returns null on access denial or missing project.
 */
async function fetchExecutionPackageContext(
  projectId: string,
): Promise<
  | { ok: true; ctx: ExecutionPackageContext; userId: string }
  | { ok: false; status: 401 | 403 | 404 | 429; error: string }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' }
  }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) {
    return { ok: false, status: 429, error: rateLimit.error ?? 'Rate limit exceeded' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()
  if (!project) return { ok: false, status: 404, error: 'Access denied' }

  const [
    { data: datasets },
    { data: approvedTMs },
    { data: qualityIssueRows },
    { data: validationRuleRows },
  ] = await Promise.all([
    supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId),
    supabaseAdmin
      .from('table_mappings')
      .select('id, source_table_id, target_table_id, status')
      .eq('project_id', projectId)
      .eq('status', 'approved'),
    supabaseAdmin
      .from('quality_issues')
      .select('id, severity, status, title, description, affected_records, generated_sql')
      .eq('project_id', projectId),
    supabaseAdmin
      .from('validation_rules')
      .select('id, name, description, rule_type, severity, rule_config')
      .eq('project_id', projectId),
  ])

  const sourceDataset = datasets?.find((d) => d.role === 'source') ?? null
  const targetDataset = datasets?.find((d) => d.role === 'target') ?? null
  const allDatasetIds = (datasets ?? []).map((d) => d.id)
  const tmIds = (approvedTMs ?? []).map((tm) => tm.id)

  const [
    { data: allTables },
    { data: tfmRows },
    { data: schemaDocRows },
  ] = await Promise.all([
    supabaseAdmin
      .from('tables')
      .select('id, dataset_id, name, row_count')
      .in('dataset_id', allDatasetIds.length ? allDatasetIds : ['__none__']),
    // NEW DATA MODEL: target_field_mappings replaces field_mappings (migration 074).
    // We query all approved TFMs in the project. The pairing to table_mapping
    // happens pure-side in `_outputs-helpers::groupTfmsByTableMapping` via the
    // primary source's source_table. Rejected / acknowledged TFMs are filtered
    // there, matching legacy `.neq('status', 'rejected')` semantics.
    supabaseAdmin
      .from('target_field_mappings')
      .select(
        'id, project_id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql, needs_transformation, va_dismissed, dismissal_reason, created_at, updated_at',
      )
      .eq('project_id', projectId)
      .eq('status', 'approved'),
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
  const tfmIds = (tfmRows ?? []).map((t) => t.id)

  const [
    { data: sourceFieldRows },
    { data: targetFieldRows },
    { data: mappingSourceRows },
    { data: transformationRows },
  ] = await Promise.all([
    sourceTableIds.length > 0
      ? supabaseAdmin
          .from('fields')
          .select('id, table_id, name, data_type, inferred_type, ordinal_position')
          .in('table_id', sourceTableIds)
          .order('ordinal_position', { ascending: true })
      : Promise.resolve({ data: [] as SourceFieldRow[] }),
    targetTableIds.length > 0
      ? supabaseAdmin
          .from('fields')
          .select(
            'id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint, ordinal_position',
          )
          .in('table_id', targetTableIds)
          .order('ordinal_position', { ascending: true })
      : Promise.resolve({ data: [] as TargetFieldRow[] }),
    // NEW DATA MODEL: mapping_sources rows owned by the approved TFMs.
    // ordinal=0 = primary, 1..N = contributors. Pairing to TM happens pure-side.
    tfmIds.length > 0
      ? supabaseAdmin
          .from('mapping_sources')
          .select(
            'id, target_field_mapping_id, source_field_id, source_table_id, confidence, ai_reasoning, similar_fields_considered, type_compatibility, join_spec, ordinal, created_at',
          )
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] as MappingSourceRow[] }),
    // NEW DATA MODEL: transformations.target_field_mapping_id (migration 074).
    tfmIds.length > 0
      ? supabaseAdmin
          .from('transformations')
          .select('id, target_field_mapping_id, description, generated_sql, is_ai_generated, test_results, status, created_at')
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] as TransformationRow[] }),
  ])

  // tmIds guard suppression: `tmIds` informs fetch planning only; the pure
  // assembler filters on approved TFMs independently.
  void tmIds

  const ctx: ExecutionPackageContext = {
    projectName: project.name,
    sourceDatasetName: sourceDataset?.name ?? null,
    targetDatasetName: targetDataset?.name ?? null,
    sourceTables: (sourceTables ?? []) as TableRow[],
    targetTables: (targetTables ?? []) as TableRow[],
    sourceFields: (sourceFieldRows ?? []) as SourceFieldRow[],
    targetFields: (targetFieldRows ?? []) as TargetFieldRow[],
    tableMappings: (approvedTMs ?? []).map((tm) => ({
      id: tm.id,
      source_table_id: tm.source_table_id,
      target_table_id: tm.target_table_id,
    })),
    // Migration 077: dismissed value assignments are excluded from
    // execution package generation. The user explicitly marked them as
    // "no value needed" via the Transform tab — they should not appear
    // in the load SQL, the prompt context, or the per-table scripts.
    // Mapping sources are unaffected (a dismissed VA has no MS rows by
    // construction); transformations are similarly skipped because a
    // VA TFM that's dismissed should not have a saved transformation
    // attached, but we belt-and-brace by also dropping any rows that
    // somehow reference a dismissed TFM.
    targetFieldMappings: ((tfmRows ?? []) as TargetFieldMappingRow[]).filter(
      (t) => t.va_dismissed !== true,
    ),
    mappingSources: (mappingSourceRows ?? []) as MappingSourceRow[],
    transformations: ((transformationRows ?? []) as TransformationRow[]).filter(
      (t) => {
        const owner = (tfmRows ?? []).find((r) => r.id === t.target_field_mapping_id)
        return !owner || owner.va_dismissed !== true
      },
    ),
    qualityIssues: (qualityIssueRows ?? []) as QualityIssueRow[],
    validationRules: (validationRuleRows ?? []) as ValidationRuleRow[],
    schemaDocs: (schemaDocRows ?? []) as SchemaDocRow[],
    generatedAt: new Date().toISOString(),
  }

  return { ok: true, ctx, userId: user.id }
}

// ─── Version helpers ────────────────────────────────────────────────────────

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

// ─── generateExecutionPackage (monolithic SQL) ─────────────────────────────

async function generateExecutionPackageInternal(
  projectId: string,
  dialect: SqlDialect,
  opts: InternalOpts,
): Promise<ExecutionPackageResult | ExecutionPackageError> {
  try {
    const fetched = await fetchExecutionPackageContext(projectId)
    if (!fetched.ok) return { success: false, error: fetched.error }

    const { ctx, userId } = fetched
    const bundle = assembleMonolithicPrompt(ctx, dialect)

    let rawSql: string
    try {
      const result = await callLLM({
        feature: 'outputs_execution_package_monolithic',
        systemPrompt: bundle.systemPrompt,
        userMessage: bundle.userMessage,
        maxTokens: bundle.maxTokens,
        projectId,
        userId,
        promptVersion: 'execution-package-monolithic-v1',
        abuseUserId: userId,
        metadata: { dialect },
      })
      // PR 12: SQL/text callsite — migrated in sub-commit 12.2.
      if (result.kind !== 'text') {
        throw new Error('outputs_execution_package_monolithic: unexpected toolUse response')
      }
      rawSql = result.text
    } catch (err) {
      console.error('[generateExecutionPackage] Claude call failed:', err)
      return { success: false, error: 'Failed to generate execution package. Please try again.' }
    }

    if (!rawSql || rawSql.trim().length < 100) {
      return { success: false, error: 'Failed to generate execution package. Please try again.' }
    }

    const dialectLabels: Record<SqlDialect, string> = {
      postgresql: 'PostgreSQL',
      tsql: 'T-SQL (MS SQL Server)',
      mysql: 'MySQL',
    }

    const header = `-- ============================================================
-- MIGRATION EXECUTION PACKAGE
-- ${ctx.sourceDatasetName ?? 'Source'} → ${ctx.targetDatasetName ?? 'Target'}
-- Generated by Settle | ${ctx.generatedAt}
-- Project: ${ctx.projectName}
-- Dialect: ${dialectLabels[dialect]}
-- ============================================================
--
-- This package contains all SQL needed to execute the migration.
-- Review each section before executing. Sections should be run
-- in order. Section 3 scripts must be run in the load order shown.
--
-- Generated from ${ctx.tableMappings.length} approved table mappings,
-- ${bundle.totalFieldMappings} field mappings, and ${bundle.totalTransformRules} transformation rules.
-- ============================================================

`

    const finalSql = header + rawSql

    if (opts.__skipPersistence) {
      return {
        success: true,
        sqlContent: finalSql,
        storagePath: '<skipped>',
        version: '0.0',
        dialect,
      }
    }

    const version = await getNextVersionStr(projectId, 'execution_package', 'sql')
    const relativePath = `outputs/execution-package/migration_execution_package_v${version}_${dialect}.sql`
    const fullStoragePath = `${userId}/${projectId}/${relativePath}`

    await supabaseAdmin.storage.from('project-files').upload(
      fullStoragePath,
      Buffer.from(finalSql, 'utf-8'),
      { contentType: 'text/plain; charset=utf-8', upsert: true },
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

export async function generateExecutionPackage(
  projectId: string,
  dialect: SqlDialect = 'postgresql',
): Promise<ExecutionPackageResult | ExecutionPackageError> {
  return generateExecutionPackageInternal(projectId, dialect, { __skipPersistence: false })
}

// ─── generateCompartmentalizedPackage ──────────────────────────────────────

async function generateCompartmentalizedPackageInternal(
  projectId: string,
  dialect: SqlDialect,
  opts: InternalOpts,
): Promise<CompartmentalizedPackageResult | ExecutionPackageError> {
  try {
    console.log('[COMPARTMENTALIZED] dialect received:', dialect)
    const fetched = await fetchExecutionPackageContext(projectId)
    if (!fetched.ok) return { success: false, error: fetched.error }

    const { ctx, userId } = fetched
    const bundle = assembleCompartmentalizedPrompt(ctx, dialect)

    let rawResponse: string
    let primaryCallId: string
    console.log('[COMPARTMENTALIZED] CRITICAL reminder dialect:', dialect)
    try {
      const result = await callLLMStreaming({
        feature: 'outputs_execution_package_compartmentalized',
        systemPrompt: bundle.systemPrompt,
        userMessage: bundle.userMessage,
        maxTokens: bundle.maxTokens,
        projectId,
        userId,
        promptVersion: 'execution-package-compartmentalized-v1',
        abuseUserId: userId,
        metadata: { dialect },
      })
      // PR 12: streaming callsite — migrated to tool use in sub-commit 12.3.
      if (result.kind !== 'text') {
        throw new Error('outputs_execution_package_compartmentalized: unexpected toolUse response')
      }
      rawResponse = result.text
      primaryCallId = result.callId
    } catch (err) {
      console.error('[generateCompartmentalizedPackage] Claude call failed:', err)
      return { success: false, error: 'Failed to generate compartmentalized package. Please try again.' }
    }

    console.log('[generateCompartmentalizedPackage] Raw response length:', rawResponse.length)

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
      let cleaned = rawResponse.trim()

      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '')
      cleaned = cleaned.replace(/\n?```\s*$/i, '')
      cleaned = cleaned.trim()

      const braceIdx = cleaned.indexOf('{')
      if (braceIdx > 0) {
        console.log('[generateCompartmentalizedPackage] Stripping preamble, starts at index', braceIdx)
        cleaned = cleaned.slice(braceIdx)
      }

      if (!cleaned.trimEnd().endsWith('}')) {
        console.warn('[generateCompartmentalizedPackage] Response may be truncated — attempting recovery')
        const lastClose = cleaned.lastIndexOf('}')
        if (lastClose !== -1) {
          cleaned = cleaned.slice(0, lastClose + 1)
          const openBrackets = (cleaned.match(/\[/g) ?? []).length - (cleaned.match(/\]/g) ?? []).length
          const openBraces = (cleaned.match(/\{/g) ?? []).length - (cleaned.match(/\}/g) ?? []).length
          for (let i = 0; i < openBrackets; i++) cleaned += ']'
          for (let i = 0; i < openBraces; i++) cleaned += '}'
          console.log(
            '[generateCompartmentalizedPackage] Recovery attempt — added',
            openBrackets,
            'brackets,',
            openBraces,
            'braces',
          )
        }
      }

      const sanitized = sanitizeClaudeJson(cleaned)
      const parsed = JSON.parse(sanitized) as { files: ClaudeFileEntry[] }
      if (!Array.isArray(parsed.files)) throw new Error('Missing files array')
      claudeFiles = parsed.files
      console.log('[generateCompartmentalizedPackage] Parsed', claudeFiles.length, 'files successfully')
    } catch (parseErr) {
      console.error('[generateCompartmentalizedPackage] JSON parse failed:', parseErr)
      return {
        success: false,
        error: 'Failed to parse structured output from AI. Try generating again, or use the single-file format.',
      }
    }

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
    for (const entry of bundle.loadOrder) {
      const match =
        tableFilesByName.get(entry.tableName.toUpperCase()) ??
        [...tableFilesByName.entries()].find(
          ([k]) => k.includes(entry.tableName.toUpperCase()) || entry.tableName.toUpperCase().includes(k),
        )?.[1]
      if (match) {
        orderedTableFiles.push({
          ...match,
          table_name: entry.tableName,
          dependencies: entry.dependencies,
        })
      } else {
        orderedTableFiles.push({
          filename: '',
          type: 'table_script',
          table_name: entry.tableName,
          dependencies: entry.dependencies,
          content: `-- ${entry.tableName}\n-- Script not generated — no approved mappings found for this table.\n`,
        })
      }
    }

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
      assembledFiles.push({
        ...validation,
        assignedFilename: `${String(validationNum).padStart(2, '0')}_post_staging_validation.sql`,
      })
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

    // ── Dialect validation + monolithic fallback ─────────────────────────────

    const tableFiles = assembledFiles.filter((f) => f.type === 'table_script')
    const failedCount = tableFiles.filter((f) => !detectDialect(f.content, dialect)).length
    if (failedCount > 0) {
      console.warn(
        `[generateCompartmentalizedPackage] Dialect validation failed: ${failedCount}/${tableFiles.length} files have wrong dialect (expected ${dialect}) — triggering monolithic fallback`,
      )

      let monoSql = ''
      try {
        const fallbackResult = await callLLM({
          feature: 'outputs_execution_package_fallback',
          systemPrompt: bundle.fallbackSystemPrompt,
          userMessage: bundle.fallbackUserMessage,
          maxTokens: bundle.fallbackMaxTokens,
          projectId,
          userId,
          promptVersion: 'execution-package-fallback-v1',
          parentCallId: primaryCallId,
          abuseUserId: userId,
          metadata: { dialect, dialect_validation_failed_count: failedCount },
        })
        // PR 12: SQL/text callsite — migrated in sub-commit 12.2.
        if (fallbackResult.kind !== 'text') {
          throw new Error('outputs_execution_package_fallback: unexpected toolUse response')
        }
        monoSql = fallbackResult.text
        console.log('[generateCompartmentalizedPackage] Monolithic fallback SQL length:', monoSql.length)
      } catch (fallbackErr) {
        console.error('[generateCompartmentalizedPackage] Monolithic fallback call failed:', fallbackErr)
        return { success: false, error: 'Dialect conversion failed. Please try again or use Single File format.' }
      }

      if (monoSql && monoSql.trim().length > 100) {
        const split = splitMonolithicSQL(monoSql, bundle.loadOrder)

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
      }
    }

    // ── Upload to storage ────────────────────────────────────────────────────

    if (opts.__skipPersistence) {
      const stubFiles: CompartmentalizedFile[] = assembledFiles.map((f, idx) => ({
        filename: f.assignedFilename,
        type: f.type as CompartmentalizedFile['type'],
        content: f.content,
        table_name: f.table_name,
        load_order: f.type === 'table_script' ? idx : undefined,
        dependencies: f.dependencies,
        storagePath: '<skipped>',
      }))
      return {
        success: true,
        files: stubFiles,
        zipStoragePath: '<skipped>',
        version: '0.0',
        dialect,
      }
    }

    const version = await getNextVersionStr(projectId, 'execution_package', 'per_table')
    const versionFolder = `${userId}/${projectId}/outputs/execution-package-v${version}_${dialect}`

    const uploadedFiles: CompartmentalizedFile[] = []
    let tableScriptIndex = 0

    for (const f of assembledFiles) {
      const storagePath = `${versionFolder}/${f.assignedFilename}`
      await supabaseAdmin.storage.from('project-files').upload(
        storagePath,
        Buffer.from(f.content, 'utf-8'),
        { contentType: 'text/plain; charset=utf-8', upsert: true },
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
      { contentType: 'application/zip', upsert: true },
    )

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

export async function generateCompartmentalizedPackage(
  projectId: string,
  dialect: SqlDialect = 'postgresql',
): Promise<CompartmentalizedPackageResult | ExecutionPackageError> {
  return generateCompartmentalizedPackageInternal(projectId, dialect, { __skipPersistence: false })
}

// ─── generateExecutionPackageWithFormat — dispatcher ───────────────────────

export async function generateExecutionPackageWithFormat(
  projectId: string,
  dialect: SqlDialect = 'postgresql',
  format: ExecutionPackageFormat = 'single_file',
): Promise<ExecutionPackageResult | CompartmentalizedPackageResult | ExecutionPackageError> {
  if (format === 'per_table') {
    return generateCompartmentalizedPackage(projectId, dialect)
  }
  return generateExecutionPackage(projectId, dialect)
}

// ─── getCompartmentalizedPackageUrls (unchanged) ───────────────────────────

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

  const { data: zipSigned } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  const manifest = output.metadata as
    | { files?: Array<{ filename: string; type: string; table_name?: string; storage_path?: string }> }
    | null
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

// ─── getExecutionPackageUrl (unchanged) ────────────────────────────────────

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

// ─── Internal helpers exposed to integration tests (Refinement 3) ──────────
//
// Integration tests that need end-to-end coverage without mutating the
// outputs table import from '@/lib/actions/_execution-package-prompt' directly
// for prompt assembly, OR from a test-only re-export module. These Internal
// functions are NOT exported from this module to keep the __skipPersistence
// flag out of reach of UI/route-handler callers. If an integration test
// needs them, add a narrow re-export in `tests/_internal/`. Do not surface
// Internal here.

export type { ExecutionPackageContext } from '@/lib/actions/_execution-package-prompt'
export type { LoadOrderEntry } from '@/lib/actions/_execution-package-prompt'
