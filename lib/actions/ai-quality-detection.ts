'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import {
  buildAIContext,
  formatSchemaForPrompt,
  formatDocumentsForPrompt,
} from '@/lib/ai/context-builder'
import type { QualityIssue } from '@/lib/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposedIssue {
  field_name: string
  cross_field?: string
  description: string
  severity: 'blocking' | 'warning'
  estimated_count: number
  verification_sql: string
  reasoning: string
}

interface ClaudeQualityResponse {
  proposed_issues: ProposedIssue[]
}

// ── Safety validator for AI-generated SQL ─────────────────────────────────────

/**
 * Only allows SELECT queries that reference data_rows and include a table_id filter.
 * Blocks any DML, DDL, or access to system/auth tables.
 */
function isVerificationSQLSafe(sql: string, tableId: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase()

  if (!normalized.startsWith('SELECT')) return false

  const lower = sql.toLowerCase()
  if (/\b(update|delete|insert|drop|alter|create|truncate|grant|revoke)\b/.test(lower)) return false
  if (/(pg_catalog|information_schema|auth\.|storage\.)/.test(lower)) return false
  if (!/data_rows/.test(lower)) return false
  if (!sql.includes(tableId)) return false

  return true
}

// ── Extract count from query result ──────────────────────────────────────────

function extractCount(result: unknown): number {
  if (typeof result === 'number') return result
  if (Array.isArray(result) && result.length > 0) {
    const row = result[0] as Record<string, unknown>
    const val = Object.values(row)[0]
    if (typeof val === 'number') return val
    if (typeof val === 'string') return parseInt(val, 10) || 0
  }
  return 0
}

// ── System prompt ─────────────────────────────────────────────────────────────

const AI_DETECTION_SYSTEM_PROMPT = `You are a data quality analyst for enterprise data migrations. You are given:
1. Field profiles from a source data table (types, null rates, value distributions, format issues)
2. Schema documentation describing the intended schema structure and known issues
3. Business context documents with migration rules and requirements
4. Existing quality issues already detected by automated rules (do NOT duplicate these)
5. Target field mappings and constraints (if available)

Your job is to identify ADDITIONAL data quality issues that the automated rules missed. Focus on:

CROSS-FIELD CHECKS:
- Conditional requirements (e.g., "amount should not be null when stage = Closed Won")
- Business logic violations (e.g., "close_date should be after created_date")
- Referential consistency (e.g., "all contact customer_id values should match a valid customer")

VALUE DOMAIN ISSUES:
- Values that don't match documented picklists or allowed values
- Inconsistent encoding of the same concept (e.g., "Won" vs "Closed Won" for the same status)
- Values that exist in the data but are not mentioned in documentation (unexpected categories)

FORMAT ISSUES NOT CAUGHT BY AUTOMATED RULES:
- ID fields with inconsistent patterns (e.g., SKU should be PRD-XXXX but some rows use different format)
- Fields documented with a specific format that data doesn't follow

DOCUMENTATION-DRIVEN ISSUES:
- Issues explicitly called out in schema documentation "Known Issues" sections
- Business rules that data violates (from business context documents)
- Constraints documented but not enforced in the source system

For each issue:
- severity "blocking" means data WILL fail to load or cause data corruption; "warning" means it needs review
- estimated_count: use the value distributions to estimate, or use a round number if uncertain
- verification_sql: a SELECT COUNT(*) query against data_rows that will confirm the exact count

CRITICAL RULES:
1. Do NOT duplicate issues already listed in <existing_issues>
2. Only propose issues you are reasonably confident exist based on the data profiles
3. The verification_sql MUST be a SELECT COUNT(*) query
4. The verification_sql MUST include: WHERE table_id = '{TABLE_ID}' (replace {TABLE_ID} with the actual UUID)
5. The verification_sql MUST only reference the data_rows table
6. Use row_data->>'field_name' (double arrow ->> for text extraction) in SQL
7. If you cannot write a safe, verifiable SQL query for an issue, omit it

Respond with ONLY valid JSON:
{
  "proposed_issues": [
    {
      "field_name": "amount",
      "cross_field": "stage",
      "description": "Null amount on closed deals — records have stage IN ('Won', 'Closed Won') but amount is NULL or empty",
      "severity": "blocking",
      "estimated_count": 2,
      "verification_sql": "SELECT COUNT(*) FROM data_rows WHERE table_id = '{TABLE_ID}' AND LOWER(TRIM(row_data->>'stage')) IN ('won', 'closed won') AND (row_data->>'amount' IS NULL OR TRIM(row_data->>'amount') = '')",
      "reasoning": "Schema documentation states amount should not be null for closed deals."
    }
  ]
}

If you find no additional issues beyond what the automated rules already detected, return: {"proposed_issues": []}`

// ── Main export ───────────────────────────────────────────────────────────────

export async function runAIAugmentedChecks(
  projectId: string,
  tableId: string
): Promise<{ issuesFound: number; skipped?: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { issuesFound: 0, error: 'Not authenticated' }

  // Rate limit check — AI augmented checks count against per-user limit
  const rateCheck = checkAIRateLimit(user.id)
  if (!rateCheck.allowed) {
    return { issuesFound: 0, skipped: true, error: 'AI rate limit reached — skipping AI augmented checks' }
  }

  // Get table info
  const { data: tableData } = await supabaseAdmin
    .from('tables')
    .select('name, row_count, dataset_id, datasets!inner(project_id, projects!inner(user_id))')
    .eq('id', tableId)
    .single()

  if (!tableData) return { issuesFound: 0, error: 'Table not found' }
  // @ts-expect-error nested join typing
  if (tableData.datasets?.projects?.user_id !== user.id) return { issuesFound: 0, error: 'Access denied' }

  const tableName = tableData.name

  // Build AI context scoped to this single table
  let aiContext
  try {
    aiContext = await buildAIContext(projectId, {
      tableIds: [tableId],
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDocChars: 12000,
      maxDistributionValues: 25,
      maxSampleValues: 10,
    }, user.id)
  } catch (err) {
    console.warn('[ai-detection] buildAIContext failed:', err)
    return { issuesFound: 0, error: 'Failed to build AI context' }
  }

  // Get existing open issues for this table so Claude doesn't duplicate them
  const { data: existingIssues } = await supabaseAdmin
    .from('quality_issues')
    .select('title, description, severity, stage')
    .eq('table_id', tableId)
    .eq('status', 'open')

  const existingIssuesSummary = (existingIssues ?? [])
    .map((i) => `- [${i.severity}] ${i.title}: ${i.description}`)
    .join('\n') || '(none)'

  // Get field mappings to this table's fields (target-aware context)
  const { data: fields } = await supabaseAdmin
    .from('fields')
    .select('id, name')
    .eq('table_id', tableId)

  const fieldIdList = (fields ?? []).map((f) => f.id)
  let mappingsSummary = ''
  if (fieldIdList.length > 0) {
    const { data: mappings } = await supabaseAdmin
      .from('field_mappings')
      .select(`
        source_field:fields!source_field_id(name, data_type),
        target_field:fields!target_field_id(name, data_type, is_nullable),
        type_compatibility
      `)
      .in('source_field_id', fieldIdList)

    if (mappings && mappings.length > 0) {
      mappingsSummary = (mappings as unknown as Array<{
        source_field: { name: string; data_type: string } | null
        target_field: { name: string; data_type: string; is_nullable: boolean } | null
        type_compatibility: string | null
      }>)
        .filter((m) => m.source_field && m.target_field)
        .map((m) => `  ${m.source_field!.name} (${m.source_field!.data_type}) → ${m.target_field!.name} (${m.target_field!.data_type}, ${m.target_field!.is_nullable ? 'nullable' : 'NOT NULL'})${m.type_compatibility ? ` — ${m.type_compatibility}` : ''}`)
        .join('\n')
    }
  }

  // Format the table context for the prompt
  const tableCtx =
    aiContext.source_tables.find((t) => t.table_id === tableId) ||
    aiContext.target_tables.find((t) => t.table_id === tableId)
  if (!tableCtx) return { issuesFound: 0, error: 'Table not found in AI context' }

  const schemaSection = formatSchemaForPrompt([tableCtx], 'source')
  const docsSection = formatDocumentsForPrompt(aiContext.documents)

  const userMessage = `${schemaSection}
${docsSection}
${aiContext.intelligence_context ? '\n' + aiContext.intelligence_context + '\n' : ''}
<target_mappings>
${mappingsSummary || '(no mappings found for this table)'}
</target_mappings>

<existing_issues>
${existingIssuesSummary}
</existing_issues>

Table ID for your verification_sql queries: ${tableId}

Identify additional data quality issues NOT already listed in existing_issues.`

  // Call Claude
  let rawResponse: string
  try {
    rawResponse = await callClaude(
      AI_DETECTION_SYSTEM_PROMPT,
      userMessage,
      2048
    )
  } catch (err) {
    console.warn('[ai-detection] Claude call failed:', err)
    return { issuesFound: 0, error: 'AI call failed' }
  }

  // Parse response
  let parsed: ClaudeQualityResponse
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found in response')
    parsed = JSON.parse(jsonMatch[0]) as ClaudeQualityResponse
  } catch {
    console.warn('[ai-detection] Failed to parse Claude response')
    return { issuesFound: 0, error: 'Failed to parse AI response' }
  }

  const proposals = parsed.proposed_issues ?? []
  if (proposals.length === 0) return { issuesFound: 0 }

  // Build a field name → field id lookup
  const fieldMap = new Map((fields ?? []).map((f) => [f.name.toLowerCase(), f.id]))

  // Validate each proposal and run its verification SQL
  const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []

  for (const proposal of proposals) {
    // Safety check on the SQL
    if (!isVerificationSQLSafe(proposal.verification_sql, tableId)) {
      console.warn('[ai-detection] Rejected unsafe SQL for field:', proposal.field_name)
      continue
    }

    // Run the verification query via the existing read-only RPC
    let actualCount = 0
    try {
      const { data: qResult, error: qError } = await supabaseAdmin.rpc('execute_readonly_query', {
        query_text: proposal.verification_sql,
      })
      if (qError) {
        console.warn('[ai-detection] Verification query failed:', qError.message)
        continue
      }
      actualCount = extractCount(qResult)
    } catch {
      console.warn('[ai-detection] Verification query threw for field:', proposal.field_name)
      continue
    }

    // Only insert if the issue is real (count > 0)
    if (actualCount <= 0) continue

    const severity = proposal.severity === 'blocking' ? 'blocking' : 'warning'
    const fieldId = fieldMap.get(proposal.field_name.toLowerCase()) ?? null

    issuesToInsert.push({
      project_id: projectId,
      table_id: tableId,
      field_id: fieldId,
      stage: 'source',
      severity,
      title: `${tableName}.${proposal.field_name}`,
      description: proposal.description,
      affected_records: actualCount,
      status: 'open',
      detection_source: 'manual_scan',
      detection_type: 'ai_augmented',
      ai_suggested_fix: null,
      ai_fix_options: null,
      downstream_impact: proposal.reasoning || null,
      generated_sql: proposal.verification_sql,
      affected_rows_sample: null,
      validation_rule_id: null,
    })
  }

  if (issuesToInsert.length > 0) {
    const { error } = await supabaseAdmin.from('quality_issues').insert(issuesToInsert)
    if (error) {
      console.error('[ai-detection] Failed to insert AI issues:', error.message)
      return { issuesFound: 0, error: error.message }
    }
  }

  return { issuesFound: issuesToInsert.length }
}
