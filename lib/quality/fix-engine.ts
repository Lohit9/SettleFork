'use server'

/**
 * AI Fix Suggestion Engine
 *
 * For a given quality issue, fetches full context and calls Claude to generate
 * 2-3 concrete fix options with SQL, tradeoffs, and downstream impact.
 * Fix suggestions are stored on the quality_issue record — generation is
 * triggered per-issue by user request, never bulk.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { callLLM, type LLMFeature } from '@/lib/ai/llm-client'
import { EMIT_FIX_OPTIONS_TOOL } from '@/lib/ai/tool-schemas'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
import { buildAIContext, formatFieldForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { resolveFixTarget } from '@/lib/quality/fix-target'
import { logAIEdit } from '@/lib/actions/ai-edit-history'
import type { FixOption } from '@/lib/types/database'

// ── Path 2 PR 2 B-1: object-style params + evalContext ───────────────────────

export interface GenerateFixSuggestionsParams {
  issueId: string
  /**
   * Path 2 PR 2 B-1: optional eval-runner injection. When set, the
   * function:
   *   1. Bypasses the Next.js auth context (createClient + auth.getUser)
   *      and uses the injected supabase + userId
   *   2. Routes the LLM call to evalContext.featureOverride
   *   3. Skips the `quality_issues.ai_fix_options` UPDATE and returns
   *      the raw `parsed.fix_options` array via `rawFixOptions`
   *
   * Production callsites omit this and behavior is unchanged.
   */
  evalContext?: {
    supabase: SupabaseClient
    userId: string
    featureOverride: LLMFeature
    skipPersist: true
  }
}

export interface GenerateFixSuggestionsResult {
  success: boolean
  /**
   * Populated only when `evalContext.skipPersist` was set. Carries the
   * AI's raw fix-options array (unfiltered by the persist UPDATE) for
   * the eval scorer.
   */
  rawFixOptions?: FixOption[]
  error?: string
}

// PR 13.1: Cached via Anthropic prompt caching (cacheControl: true).
// Editing this string invalidates the prompt cache; expect a 1-day cost
// spike after deploys that touch this prompt while the cache rewarms.
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

E) Numeric fix — CAST-SAFE (CRITICAL):
NEVER cast row_data->>'Field' directly to numeric in a WHERE clause or SET clause without first
checking the value is actually numeric. A bare ::numeric cast on a non-numeric value (empty string,
"N/A", text) will throw "invalid input syntax for type numeric" and abort the entire operation.

WRONG — crashes on any non-numeric row:
  WHERE table_id = '<uuid>' AND (row_data->>'Price')::numeric < 0

CORRECT — regex guard before cast:
  UPDATE data_rows
  SET row_data = jsonb_set(
    row_data, '{Price}',
    to_jsonb(ABS((row_data->>'Price')::numeric))
  )
  WHERE table_id = '<table_uuid>'
    AND row_data->>'Price' ~ '^-?[0-9]+(\.[0-9]+)?$'
    AND (row_data->>'Price')::numeric < 0

The regex '^-?[0-9]+(\.[0-9]+)?$' matches plain integers and decimals (negative or positive).
Adjust the regex if the field can use scientific notation or currency symbols.
ALWAYS include this regex guard before ANY ::numeric (or ::integer, ::float) cast — in both
the WHERE clause AND the SET clause expression.

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

DATE FORMAT FIX RULE — CRITICAL:
When fixing date format issues (non-ISO dates, mixed formats), NEVER use a single TO_DATE(field, 'format') call.
A single format will crash on mixed data (e.g., "22/11/2025" fails with MM/DD/YYYY because month=22).
Use a CASE + regex approach with one WHEN branch per format.

CRITICAL — NULL SAFETY: NEVER wrap the CASE in to_jsonb() directly, because to_jsonb(NULL) produces SQL NULL
which makes jsonb_set return NULL for the entire row_data, violating the NOT NULL constraint.
Instead, use an OUTER CASE at the SET level so rows with unparseable dates keep their original value:

  UPDATE data_rows
  SET row_data = CASE
    WHEN (
      CASE
        WHEN row_data->>'FieldName' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN row_data->>'FieldName'
        WHEN row_data->>'FieldName' ~ '^[0-9]{4}/[0-9]' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'YYYY/MM/DD'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' AND SPLIT_PART(row_data->>'FieldName', '/', 1)::int > 12 THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'DD/MM/YYYY'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM/DD/YYYY'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM/DD/YY'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' AND SPLIT_PART(row_data->>'FieldName', '-', 1)::int > 12 THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'DD-MM-YYYY'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM-DD-YYYY'), 'YYYY-MM-DD')
        WHEN row_data->>'FieldName' ~* '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)' THEN TO_CHAR((row_data->>'FieldName')::date, 'YYYY-MM-DD')
        ELSE NULL
      END
    ) IS NOT NULL
      THEN jsonb_set(row_data, '{FieldName}', to_jsonb((
        CASE
          WHEN row_data->>'FieldName' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN row_data->>'FieldName'
          WHEN row_data->>'FieldName' ~ '^[0-9]{4}/[0-9]' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'YYYY/MM/DD'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' AND SPLIT_PART(row_data->>'FieldName', '/', 1)::int > 12 THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'DD/MM/YYYY'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM/DD/YYYY'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM/DD/YY'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' AND SPLIT_PART(row_data->>'FieldName', '-', 1)::int > 12 THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'DD-MM-YYYY'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' THEN TO_CHAR(TO_DATE(row_data->>'FieldName', 'MM-DD-YYYY'), 'YYYY-MM-DD')
          WHEN row_data->>'FieldName' ~* '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)' THEN TO_CHAR((row_data->>'FieldName')::date, 'YYYY-MM-DD')
          ELSE NULL
        END
      )))
    ELSE row_data
  END
  WHERE table_id = '<uuid>'
    AND row_data->>'FieldName' IS NOT NULL
    AND row_data->>'FieldName' != ''
    AND row_data->>'FieldName' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}';

The outer CASE checks if the conversion succeeds (IS NOT NULL). If yes, it updates the field.
If no (truly unparseable value), it leaves row_data unchanged — avoiding the NOT NULL constraint violation.
Replace FieldName with the actual field name. Remove WHEN branches not needed for this data.

LPAD / RPAD CAST RULE:
LPAD and RPAD require TEXT as their first argument. Always cast numeric values to text first:
  CORRECT: LPAD(some_number::text, 7, '0')
  WRONG:   LPAD(some_number, 7, '0')  ← crashes with "function lpad(bigint, integer, unknown) does not exist"

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
  params: GenerateFixSuggestionsParams,
): Promise<GenerateFixSuggestionsResult> {
  const { issueId, evalContext } = params

  let supabase: SupabaseClient
  let user: { id: string }
  if (evalContext) {
    supabase = evalContext.supabase
    user = { id: evalContext.userId }
  } else {
    supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { success: false, error: 'Not authenticated' }
    user = authUser
  }

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

  // Resolve the effective fix target — for in-flight issues this routes from
  // the (empty) target table to the source table + source field name so the
  // generated SQL operates on real data_rows. applyFix() uses the same
  // resolver, so the table_id it validates against will match what we put in
  // the prompt.
  const fixTarget = await resolveFixTarget({
    id: issue.id as string,
    project_id: issue.project_id as string,
    stage: issue.stage as 'source' | 'in_flight' | 'target',
    table_id: (issue.table_id as string | null) ?? null,
    field_id: (issue.field_id as string | null) ?? null,
  })

  if (issue.stage === 'in_flight' && !fixTarget.routedToSource) {
    return {
      success: false,
      error:
        `Cannot generate fix suggestions — ${fixTarget.routingBlockedReason ?? 'no source mapping for this target field'}. ` +
        'This issue must be resolved by adding a mapping or default value rather than a data fix.',
    }
  }

  const effectiveTableId = fixTarget.tableId
  const effectiveFieldId = fixTarget.fieldId

  // Build rich AI context for the affected field: value distributions + docs
  // Uses RLS client since ownership has already been verified above.
  // Routing note: for in-flight issues we feed the context builder the
  // SOURCE table/field (effectiveTableId/effectiveFieldId) so profiling
  // stats and value distributions reflect the actual rows the fix will
  // operate on.
  let fieldContext = 'No field information available.'
  let tableName = 'unknown'
  let fixDocBlock = ''

  if (issue.project_id) {
    try {
      // Path 2 PR 2 B-2: pass the caller-supplied supabase client through
      // when running under evalContext (CLI runs outside a request scope,
      // so the default createClient() cookies path throws). Production
      // callers omit evalContext and the 4th arg stays undefined.
      const fixCtx = await buildAIContext(
        issue.project_id as string,
        {
          tableIds: effectiveTableId ? [effectiveTableId] : [],
          fieldIds: effectiveFieldId ? [effectiveFieldId] : [],
          includeProfilingStats: true,
          includeValueDistributions: true,
          includeSampleValues: true,
          includeDocuments: true,
          maxDistributionValues: 15,
        },
        undefined,
        evalContext ? supabase : undefined,
      )

      // Find the affected field context (search source + target tables)
      const allFieldCtxs = [...fixCtx.source_tables, ...fixCtx.target_tables].flatMap((t) => t.fields)
      const affectedFieldCtx = allFieldCtxs[0] // filtered by fieldId — at most one field

      if (affectedFieldCtx) {
        fieldContext = formatFieldForPrompt(affectedFieldCtx)
      }

      // Get table name from context
      const allTableCtxs = [...fixCtx.source_tables, ...fixCtx.target_tables]
      if (allTableCtxs[0]) {
        tableName = allTableCtxs[0].table_name
      }

      fixDocBlock = formatDocumentsForPrompt(fixCtx.documents)
    } catch {
      // Fall back to admin fetch if context builder fails (e.g., no dataset for this table)
      if (effectiveFieldId) {
        const { data: field } = await supabaseAdmin
          .from('fields')
          .select('name, data_type, inferred_type, is_nullable, is_primary_key')
          .eq('id', effectiveFieldId)
          .single()
        if (field) {
          fieldContext = `Field: ${field.name}\nType: ${field.data_type} (inferred: ${field.inferred_type ?? 'unknown'})\nNullable: ${field.is_nullable}`
        }
      }
      if (effectiveTableId) {
        const { data: table } = await supabaseAdmin.from('tables').select('name').eq('id', effectiveTableId).single()
        if (table) tableName = table.name
      }
    }
  } else {
    // No project_id — fall back to direct admin queries
    if (effectiveFieldId) {
      const { data: field } = await supabaseAdmin
        .from('fields')
        .select('name, data_type, inferred_type, is_nullable, is_primary_key')
        .eq('id', effectiveFieldId)
        .single()
      if (field) {
        fieldContext = `Field: ${field.name}\nType: ${field.data_type} (inferred: ${field.inferred_type ?? 'unknown'})\nNullable: ${field.is_nullable}`
      }
    }
    if (effectiveTableId) {
      const { data: table } = await supabaseAdmin.from('tables').select('name').eq('id', effectiveTableId).single()
      if (table) tableName = table.name
    }
  }

  // Target-side context: what constraint is being violated. For source-stage
  // issues this is the downstream mapping (source→target). For in-flight
  // issues we already know target constraints — look them up by the
  // ORIGINAL target field_id stored on the issue.
  let targetContext = 'No target mapping exists yet.'
  if (fixTarget.routedToSource && issue.field_id) {
    const { data: tf } = await supabaseAdmin
      .from('fields')
      .select('name, data_type, is_nullable')
      .eq('id', issue.field_id as string)
      .single()
    if (tf) {
      targetContext = `Target field: ${tf.name} (${tf.data_type})
Target nullable: ${tf.is_nullable}
Note: the fix must operate on the SOURCE table above (${tableName}) since target tables have no data.`
    }
  } else if (issue.field_id) {
    // Source-stage issue: find the TFM this source field feeds into so we
    // can surface its target field in <target_context> for Claude.
    //
    // Prompt 3d (2026-04-22): the legacy field_mappings query used no
    // status filter and .limit(1), taking whatever row Postgres surfaced
    // first. Preserved byte-for-byte here — adding a status filter would
    // change which mapping's target field Claude sees when a source
    // participates in multiple TFMs.
    const { data: msRow } = await supabaseAdmin
      .from('mapping_sources')
      .select(`
        target_field_mappings!inner (
          target_field:fields!target_field_id(name, data_type, is_nullable)
        )
      `)
      .eq('source_field_id', issue.field_id)
      .limit(1)
      .maybeSingle()

    const targetField = (msRow as { target_field_mappings?: { target_field?: { name: string; data_type: string; is_nullable: boolean } | null } } | null)
      ?.target_field_mappings?.target_field ?? null

    if (targetField) {
      targetContext = `Mapped to: ${targetField.name} (${targetField.data_type})
Target nullable: ${targetField.is_nullable}`
    }
  }

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

  const routingNote = fixTarget.routedToSource
    ? `\nRouting: this in-flight issue was detected on the target field, but the fix must operate on the SOURCE table ('${tableName}') because target tables have no rows. Use the source field name shown in field_context in all JSONB expressions.`
    : ''

  const userMessage = `<issue>
Issue: ${issue.title} — ${issue.description}
Severity: ${issue.severity}
Stage: ${issue.stage}
Affected records: ${issue.affected_records}
Table ID: ${effectiveTableId}${routingNote}
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

Provide 2-3 fix options for this issue. Use table_id = '${effectiveTableId}' in all SQL WHERE clauses.`

  // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  let parsed: ClaudeFixResponse
  let llmCallId: string | null = null
  try {
    const issueProjectId = (issue as unknown as { project_id: string }).project_id
    const result = await callLLM({
      feature: evalContext?.featureOverride ?? 'quality_fix_options',
      systemPrompt: withProvenanceGuidance(SYSTEM_PROMPT),
      userMessage,
      maxTokens: 4096,
      projectId: issueProjectId,
      userId: user.id,
      promptVersion: 'quality-fix-options-v1',
      abuseUserId: user.id,
      metadata: { issue_id: issueId, effective_table_id: effectiveTableId },
      ...(phase2Enabled && { tool: EMIT_FIX_OPTIONS_TOOL }),
      // PR 13.1: prompt caching. SYSTEM_PROMPT carries the SQL safety
      // rules + 5-condition risk rubric (~4K tk); EMIT_FIX_OPTIONS_TOOL
      // is similarly large. Per-issue invocation locality is medium
      // (multiple issues in one quality-review session).
      // PR-CACHE-HOTFIX: disabled to unblock 4-block limit. See INF-5 for
      // selective re-enable on top 4 blocks.
      cacheControl: false,
    })
    llmCallId = result.callId

    if (result.kind === 'toolUse') {
      parsed = result.toolUse.input as unknown as ClaudeFixResponse
    } else {
      // Strip markdown fences if present
      const cleaned = result.text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()

      parsed = JSON.parse(cleaned)
    }
  } catch (err) {
    console.error('[fix-engine] Failed to parse Claude response:', err)
    return { success: false, error: 'AI returned an unexpected response. Please try again.' }
  }

  if (!parsed.fix_options || !Array.isArray(parsed.fix_options)) {
    return { success: false, error: 'AI did not return valid fix options. Please try again.' }
  }

  // Path 2 PR 2 B-1: eval skipPersist — bypass the quality_issues UPDATE
  // and return the raw fix_options array so the eval scorer measures
  // AI output as emitted. Production (no evalContext) continues with
  // the existing persistence pipeline below.
  if (evalContext?.skipPersist) {
    return { success: true, rawFixOptions: parsed.fix_options }
  }

  // Capture pre-write ai_fix_options so the diff is recoverable.
  const previousFixOptions = (issue as unknown as { ai_fix_options: unknown }).ai_fix_options ?? null

  // Update the quality issue record
  const firstOption = parsed.fix_options[0]
  const { error: updateError } = await supabaseAdmin
    .from('quality_issues')
    .update({
      ai_fix_options: parsed.fix_options,
      downstream_impact: parsed.downstream_impact ?? null,
      ai_suggested_fix: firstOption?.description ?? null,
      generated_sql: firstOption?.sql ?? null,
      // Freeze the AI's first proposal. Only set on the first AI write
      // to this issue — leave NULL afterwards so subsequent regenerations
      // never overwrite the original.
      ...(previousFixOptions == null
        ? { original_ai_fix_options: parsed.fix_options }
        : {}),
    })
    .eq('id', issueId)

  if (updateError) {
    console.error('[fix-engine] Failed to store fix options:', updateError.message)
    return { success: false, error: 'Failed to save fix suggestions. Please try again.' }
  }

  // Provenance: AI wrote ai_fix_options. ai_replaced when overwriting an
  // existing AI proposal (regen); ai_proposed for the first AI write.
  void logAIEdit({
    projectId: (issue as unknown as { project_id: string }).project_id,
    actorId: user.id,
    entityType: 'quality_issue',
    entityId: issueId,
    fieldPath: 'ai_fix_options',
    oldValue: previousFixOptions,
    newValue: parsed.fix_options,
    editKind: previousFixOptions == null ? 'ai_proposed' : 'ai_replaced',
    llmCallId,
    metadata: { effective_table_id: effectiveTableId },
  })

  return { success: true }
}
