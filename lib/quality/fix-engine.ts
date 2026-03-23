'use server'

/**
 * AI Fix Suggestion Engine
 *
 * For a given quality issue, fetches full context and calls Claude to generate
 * 2-3 concrete fix options with SQL, tradeoffs, and downstream impact.
 * Fix suggestions are stored on the quality_issue record — generation is
 * triggered per-issue by user request, never bulk.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { getSchemaDocumentContext, formatDocumentContextForPrompt } from '@/lib/ai/document-context'
import type { FixOption } from '@/lib/types/database'

const SYSTEM_PROMPT = `You are a senior enterprise data migration consultant. A data quality issue has been detected in a migration project. Your job is to:
1. Explain the root cause clearly
2. Assess downstream impact — what breaks if this isn't fixed
3. Propose 2-3 fix options with different tradeoffs
4. For each fix, provide exact, executable SQL

The data is stored in a table called 'data_rows' with:
- table_id UUID
- row_data JSONB (contains the actual field values as key-value pairs)

SQL PATTERNS BY ISSUE TYPE:

A) Update an existing field value:
  UPDATE data_rows
  SET row_data = jsonb_set(row_data, '{FieldName}', '"new_value"')
  WHERE table_id = '<table_uuid>' AND row_data->>'FieldName' = 'bad_value'

B) Add a new field that doesn't exist yet (e.g., missing required target field):
  UPDATE data_rows
  SET row_data = row_data || '{"FieldName": "default_value"}'::jsonb
  WHERE table_id = '<table_uuid>'

C) Remove rows with bad data:
  DELETE FROM data_rows
  WHERE table_id = '<table_uuid>' AND <condition>

D) Fix nulls / empty values with a default:
  UPDATE data_rows
  SET row_data = jsonb_set(row_data, '{FieldName}', '"default"')
  WHERE table_id = '<table_uuid>'
    AND (row_data->>'FieldName' IS NULL OR row_data->>'FieldName' = '')

E) Numeric fix (cast-safe):
  UPDATE data_rows
  SET row_data = jsonb_set(row_data, '{Price}', to_jsonb(1300.0))
  WHERE table_id = '<table_uuid>' AND (row_data->>'Price')::numeric < 1300

CRITICAL SQL CONSTRAINTS:
- SQL must ALWAYS include WHERE table_id = '<the exact uuid provided in context>'
- Never reference tables other than data_rows
- Never use DDL (DROP, ALTER, CREATE, TRUNCATE)
- Use JSONB operators for all field access: row_data->>'FieldName'
- Every WHERE clause must anchor on the table_id
- For missing fields, use the || jsonb merge operator (pattern B above)
- NEVER use LIMIT, FETCH FIRST, FETCH NEXT, or OFFSET in fix SQL — fixes must apply
  to ALL matching rows, not a subset. The validator will REJECT any SQL with LIMIT/FETCH.
  Write the WHERE clause to be specific instead of using a row limit.

WINDOW FUNCTION RULE — VERY IMPORTANT:
PostgreSQL does NOT allow window functions (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD,
NTILE, etc.) inside an UPDATE SET clause. If you need sequential IDs or ranking,
you MUST use a CTE (WITH clause). The validator will REJECT any UPDATE that contains
OVER() directly in the SET clause.

WRONG — will fail with "window functions are not allowed in UPDATE":
  UPDATE data_rows
  SET row_data = jsonb_set(row_data, '{id}', to_jsonb(ROW_NUMBER() OVER()))
  WHERE table_id = '...'

CORRECT — use a CTE to compute the window function first:
  WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY row_number) AS rn
    FROM data_rows WHERE table_id = '<uuid>'
  )
  UPDATE data_rows d
  SET row_data = jsonb_set(d.row_data, '{field}', to_jsonb(n.rn))
  FROM numbered n
  WHERE d.id = n.id AND d.table_id = '<uuid>'

The simpler alternative for adding a default value to all rows (preferred when possible):
  UPDATE data_rows
  SET row_data = row_data || '{"field_name": "default_value"}'::jsonb
  WHERE table_id = '<uuid>'

Always choose the simplest correct pattern. Avoid window functions unless strictly required.

If documentation is provided, follow the data quality rules and exception handling procedures specified in the business rules. For example, if the documentation says negative revenue should be flagged for business review rather than auto-corrected, your fix suggestions must respect that. Reference specific rules from the documentation in your fix descriptions when applicable.

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "root_cause": "Clear explanation of why this issue exists",
  "downstream_impact": "What breaks if this is not fixed — be specific about target tables and record counts",
  "fix_options": [
    {
      "label": "Short name (e.g., 'Filter out null records')",
      "description": "What this fix does in plain English",
      "sql": "The exact SQL to execute — must include WHERE table_id = '<uuid>'",
      "tradeoff": "What you gain and what you lose with this approach",
      "downstream_impact": "How this fix specifically affects the migration",
      "risk_level": "low",
      "estimated_rows_affected": 45
    }
  ]
}`

interface ClaudeFixResponse {
  root_cause: string
  downstream_impact: string
  fix_options: FixOption[]
}

export async function generateFixSuggestions(
  issueId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Rate limit
  const rateLimitOk = checkAIRateLimit(user.id)
  if (!rateLimitOk) {
    return { success: false, error: 'AI rate limit reached. Please wait before generating more fix suggestions.' }
  }

  // Fetch issue with ownership check
  const { data: issue } = await supabaseAdmin
    .from('quality_issues')
    .select('*, projects!inner(user_id)')
    .eq('id', issueId)
    .single()

  if (!issue) return { success: false, error: 'Issue not found' }
  if ((issue as unknown as { projects: { user_id: string } }).projects?.user_id !== user.id) {
    return { success: false, error: 'Access denied' }
  }

  // Fetch field context
  let fieldContext = 'No field information available.'
  if (issue.field_id) {
    const { data: field } = await supabaseAdmin
      .from('fields')
      .select('*, field_profiles(*)')
      .eq('id', issue.field_id)
      .single()

    if (field) {
      const profile = (field.field_profiles as { null_percentage?: number; cardinality?: number; sample_values?: unknown[] }[])?.[0]
      fieldContext = `Field: ${field.name}
Type: ${field.data_type} (inferred: ${field.inferred_type ?? 'unknown'})
Nullable: ${field.is_nullable}
Primary Key: ${field.is_primary_key}
Null rate: ${profile?.null_percentage ?? 0}%
Cardinality: ${profile?.cardinality ?? 'unknown'}
Sample values: ${JSON.stringify(profile?.sample_values?.slice(0, 10) ?? [])}`
    }
  }

  // Fetch table context
  let tableName = 'unknown'
  if (issue.table_id) {
    const { data: table } = await supabaseAdmin
      .from('tables')
      .select('name')
      .eq('id', issue.table_id)
      .single()
    if (table) tableName = table.name
  }

  // Fetch target mapping context
  let targetContext = 'No target mapping exists yet.'
  if (issue.field_id) {
    const { data: fmData } = await supabaseAdmin
      .from('field_mappings')
      .select(`
        target_field:fields!target_field_id(name, data_type, is_nullable)
      `)
      .eq('source_field_id', issue.field_id)
      .limit(1)
      .maybeSingle()

    if (fmData?.target_field) {
      const tf = fmData.target_field as unknown as { name: string; data_type: string; is_nullable: boolean }
      targetContext = `Mapped to: ${tf.name} (${tf.data_type})
Target nullable: ${tf.is_nullable}`
    }
  }

  // Fetch schema document context (source + target docs, up to 15k chars each)
  const fixDocBlock = issue.project_id
    ? formatDocumentContextForPrompt(await getSchemaDocumentContext(issue.project_id as string))
    : ''

  // Fetch other open issues on the same table (to avoid conflicting fixes)
  let otherIssues = 'No other open issues on this table.'
  if (issue.table_id) {
    const { data: others } = await supabaseAdmin
      .from('quality_issues')
      .select('title, description, severity')
      .eq('table_id', issue.table_id)
      .eq('status', 'open')
      .neq('id', issueId)
      .limit(5)

    if (others && others.length > 0) {
      otherIssues = others.map((o) => `- [${o.severity}] ${o.title}: ${o.description}`).join('\n')
    }
  }

  // Build samples string
  const sampleRows = issue.affected_rows_sample ?? []
  const samplesStr =
    sampleRows.length > 0
      ? JSON.stringify(sampleRows.slice(0, 10), null, 2)
      : 'No sample rows captured.'

  const userMessage = `<issue>
Issue: ${issue.title} — ${issue.description}
Severity: ${issue.severity}
Stage: ${issue.stage}
Affected records: ${issue.affected_records}
Table ID: ${issue.table_id ?? 'unknown'}
</issue>

<field_context>
${fieldContext}
Table: ${tableName}
</field_context>

<affected_rows_sample>
${samplesStr}
</affected_rows_sample>

<target_context>
${targetContext}
</target_context>

${fixDocBlock}
<other_issues>
${otherIssues}
</other_issues>

Provide 2-3 fix options for this issue. Use table_id = '${issue.table_id ?? ''}' in all SQL WHERE clauses.`

  let parsed: ClaudeFixResponse
  try {
    const raw = await callClaude(SYSTEM_PROMPT, userMessage, 2048)

    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    parsed = JSON.parse(cleaned)
  } catch (err) {
    console.error('[fix-engine] Failed to parse Claude response:', err)
    return { success: false, error: 'AI returned an unexpected response. Please try again.' }
  }

  if (!parsed.fix_options || !Array.isArray(parsed.fix_options)) {
    return { success: false, error: 'AI did not return valid fix options. Please try again.' }
  }

  // Update the quality issue record
  const firstOption = parsed.fix_options[0]
  const { error: updateError } = await supabaseAdmin
    .from('quality_issues')
    .update({
      ai_fix_options: parsed.fix_options,
      downstream_impact: parsed.downstream_impact ?? null,
      ai_suggested_fix: firstOption?.description ?? null,
      generated_sql: firstOption?.sql ?? null,
    })
    .eq('id', issueId)

  if (updateError) {
    console.error('[fix-engine] Failed to store fix options:', updateError.message)
    return { success: false, error: 'Failed to save fix suggestions. Please try again.' }
  }

  return { success: true }
}
