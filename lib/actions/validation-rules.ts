'use server'

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { callLLM, type LLMFeature } from '@/lib/ai/llm-client'
import { EMIT_VALIDATION_RULE_TOOL } from '@/lib/ai/tool-schemas'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import { logActivity } from '@/lib/actions/activity-log'
import { logAIEdit } from '@/lib/actions/ai-edit-history'
import type { ValidationRule, QualityIssue } from '@/lib/types/database'

// ── helpers ───────────────────────────────────────────────────────────────────

function generateRuleDescription(ruleType: string, config: Record<string, unknown>): string {
  switch (ruleType) {
    case 'not_null':       return 'Field must not be null or empty'
    case 'unique':         return 'Values must be unique (no duplicates)'
    case 'min_value':      return `Value must be ≥ ${config.min}`
    case 'max_value':      return `Value must be ≤ ${config.max}`
    case 'min_length':     return `Length must be ≥ ${config.min_length} characters`
    case 'max_length':     return `Length must be ≤ ${config.max_length} characters`
    case 'allowed_values': return `Value must be one of: ${(config.values as string[] | undefined ?? []).join(', ')}`
    case 'regex':          return `Value must match pattern: ${config.pattern}`
    case 'range':          return `Value must be between ${config.min} and ${config.max}`
    case 'date_after':     return `Date must be after ${config.date}`
    case 'date_before':    return `Date must be before ${config.date}`
    default:               return `Rule "${ruleType}" must be satisfied`
  }
}

/**
 * Validates that rule_config has the correct shape for the given rule_type.
 * Returns null when valid, an error message when invalid.
 */
function validateRuleConfig(
  ruleType: string,
  config: Record<string, unknown>
): string | null {
  switch (ruleType) {
    case 'not_null':
    case 'unique':
      return null

    case 'min_value':
      if (typeof config.min !== 'number' || isNaN(config.min as number)) {
        return "Invalid rule config for min_value: 'min' must be a number"
      }
      return null

    case 'max_value':
      if (typeof config.max !== 'number' || isNaN(config.max as number)) {
        return "Invalid rule config for max_value: 'max' must be a number"
      }
      return null

    case 'min_length':
      if (
        typeof config.min_length !== 'number' ||
        isNaN(config.min_length as number) ||
        !Number.isInteger(config.min_length)
      ) {
        return "Invalid rule config for min_length: 'min_length' must be an integer"
      }
      return null

    case 'max_length':
      if (
        typeof config.max_length !== 'number' ||
        isNaN(config.max_length as number) ||
        !Number.isInteger(config.max_length)
      ) {
        return "Invalid rule config for max_length: 'max_length' must be an integer"
      }
      return null

    case 'regex': {
      if (typeof config.pattern !== 'string' || !config.pattern.trim()) {
        return "Invalid rule config for regex: 'pattern' must be a non-empty string"
      }
      try {
        new RegExp(config.pattern as string)
      } catch {
        return "Invalid rule config for regex: pattern is not a valid regular expression"
      }
      return null
    }

    case 'allowed_values':
      if (!Array.isArray(config.values) || (config.values as unknown[]).length === 0) {
        return "Invalid rule config for allowed_values: 'values' must be a non-empty array"
      }
      return null

    case 'range': {
      if (typeof config.min !== 'number' || isNaN(config.min as number)) {
        return "Invalid rule config for range: 'min' must be a number"
      }
      if (typeof config.max !== 'number' || isNaN(config.max as number)) {
        return "Invalid rule config for range: 'max' must be a number"
      }
      if ((config.min as number) > (config.max as number)) {
        return "Invalid rule config for range: 'min' must be ≤ 'max'"
      }
      return null
    }

    case 'date_after':
    case 'date_before':
      if (
        typeof config.date !== 'string' ||
        !config.date.trim() ||
        isNaN(Date.parse(config.date as string))
      ) {
        return `Invalid rule config for ${ruleType}: 'date' must be a valid date string (e.g. '2020-01-01')`
      }
      return null

    case 'custom_sql':
      if (typeof config.sql !== 'string' || !config.sql.trim()) {
        return "Invalid rule config for custom_sql: 'sql' must be a non-empty string"
      }
      return null

    default:
      return null
  }
}

// ── add a rule directly ───────────────────────────────────────────────────────

export async function addValidationRule(
  projectId: string,
  fieldId: string | null,
  tableId: string | null,
  rule: {
    name: string
    rule_type: string
    rule_config: Record<string, unknown>
    severity: 'blocking' | 'warning'
    description?: string
  }
): Promise<{ success: boolean; rule?: ValidationRule; error?: string }> {
  // Fix 5: must supply at least a table or field
  if (!fieldId && !tableId) {
    return { success: false, error: 'Must select a table or field for the validation rule' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { success: false, error: 'Project not found or access denied' }

  // Fix 5: resolve table_id from field when missing
  let resolvedTableId = tableId
  if (fieldId && !resolvedTableId) {
    const { data: fieldRow } = await supabase
      .from('fields')
      .select('table_id')
      .eq('id', fieldId)
      .single()
    resolvedTableId = fieldRow?.table_id ?? null
    if (!resolvedTableId) {
      return { success: false, error: 'Field not found — cannot determine table for validation rule' }
    }
  }

  // Fix 2: validate rule_config shape
  const configError = validateRuleConfig(rule.rule_type, rule.rule_config)
  if (configError) return { success: false, error: configError }

  // Custom SQL must be SELECT-only
  if (rule.rule_type === 'custom_sql' && rule.rule_config.sql) {
    const sqlStr = String(rule.rule_config.sql)
    if (!/^\s*SELECT/i.test(sqlStr)) {
      return { success: false, error: 'Custom SQL rules must be SELECT statements only' }
    }
    if (/(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sqlStr)) {
      return {
        success: false,
        error: 'Custom SQL rules must not contain data modification statements',
      }
    }
  }

  const description =
    rule.description?.trim() || generateRuleDescription(rule.rule_type, rule.rule_config)

  // Fix 1: use RLS client for validation_rules INSERT — RLS policy enforces project ownership
  const { data, error } = await supabase
    .from('validation_rules')
    .insert({
      project_id: projectId,
      field_id: fieldId,
      table_id: resolvedTableId,
      name: rule.name,
      description,
      rule_type: rule.rule_type,
      rule_config: rule.rule_config,
      severity: rule.severity,
      is_ai_generated: false,
    })
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  const insertedRule = data as ValidationRule
  await logActivity(
    projectId,
    'rule_added',
    `Validation rule added: ${rule.name}`,
    'validation',
    { validation_rule_id: insertedRule.id, rule_type: rule.rule_type }
  )

  // Provenance: user-authored rule (no prior AI proposal). Path A — emits
  // alongside the existing logActivity call so the Activity tab and the
  // structured-diff history stay in sync.
  void logAIEdit({
    projectId,
    actorId: user.id,
    entityType: 'validation_rule',
    entityId: insertedRule.id,
    fieldPath: 'rule_config',
    oldValue: null,
    newValue: {
      name: rule.name,
      rule_type: rule.rule_type,
      rule_config: rule.rule_config,
      severity: rule.severity,
    },
    editKind: 'human_authored',
    metadata: { table_id: resolvedTableId, field_id: fieldId },
  })

  return { success: true, rule: insertedRule }
}

// ── add a rule from natural language ─────────────────────────────────────────

export async function addValidationRuleFromNL(
  projectId: string,
  fieldId: string,
  naturalLanguageRule: string,
  severityOverride?: 'blocking' | 'warning',
  // Path 2 PR 1: optional eval-runner injection. When present, bypasses
  // the Next.js auth context (the eval runner has no request scope) and
  // routes the LLM call to the eval_* feature taxonomy so production
  // cost reports stay clean. Production callsites omit this parameter
  // and behavior is unchanged. Mirrors the runMappingGenerationForPair
  // pattern (lib/actions/mappings.ts:121).
  evalContext?: {
    supabase: SupabaseClient
    userId: string
    featureOverride: LLMFeature
  },
): Promise<{ success: boolean; rule?: ValidationRule; error?: string }> {
  // Fix 5: fieldId is required for NL rules
  if (!fieldId) {
    return { success: false, error: 'Must select a field for the validation rule' }
  }

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

  if (!checkAIRateLimit(user.id)) {
    return {
      success: false,
      error: 'AI rate limit reached. Please wait before generating more rules.',
    }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { success: false, error: 'Project not found or access denied' }

  // Fix 1: use RLS client to fetch field context — fields have proper RLS policies
  const { data: field } = await supabase
    .from('fields')
    .select('*, tables!inner(id, name, dataset_id), field_profiles(*)')
    .eq('id', fieldId)
    .single()

  if (!field) return { success: false, error: 'Field not found' }

  // Fix 5: table_id is always set from field.table_id
  const tableId: string = field.table_id as string
  if (!tableId) {
    return { success: false, error: 'Field has no associated table — cannot create rule' }
  }

  const tableName = (field as unknown as { tables: { name: string } }).tables?.name ?? 'unknown'
  const profile = (field.field_profiles as { sample_values?: unknown[] }[])?.[0]
  const sampleValues = profile?.sample_values?.slice(0, 10) ?? []

  const systemPrompt = `You are a data validation expert. Given a field's metadata and a natural language description of a validation rule, generate a structured validation rule.
Respond with ONLY valid JSON (no markdown, no code fences):
{
  "name": "Short rule name",
  "description": "What this rule checks",
  "rule_type": "one of: not_null, unique, min_value, max_value, min_length, max_length, regex, allowed_values, range, date_after, date_before",
  "rule_config": { ... config specific to rule_type ... },
  "severity": "blocking or warning"
}

rule_config formats by type:
- not_null: {}
- unique: {}
- min_value: { "min": 0 }
- max_value: { "max": 1000000 }
- min_length: { "min_length": 3 }
- max_length: { "max_length": 100 }
- regex: { "pattern": "^[A-Z]{2}\\d{4}$", "description": "Two letters followed by 4 digits" }
- allowed_values: { "values": ["Active", "Inactive"] }
- range: { "min": 0, "max": 100 }
- date_after: { "date": "2020-01-01" }
- date_before: { "date": "2030-12-31" }`

  const userMessage = `Field: ${tableName}.${field.name} (${field.data_type}, inferred: ${field.inferred_type ?? 'text'})
Sample values: ${JSON.stringify(sampleValues)}
User's rule: "${naturalLanguageRule}"`

  // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  let parsed: {
    name: string
    description: string
    rule_type: string
    rule_config: Record<string, unknown>
    severity: 'blocking' | 'warning'
  }
  let llmCallId: string | null = null

  try {
    const result = await callLLM({
      feature: evalContext?.featureOverride ?? 'validation_rule_from_nl',
      systemPrompt,
      userMessage,
      maxTokens: 512,
      projectId,
      userId: user.id,
      promptVersion: 'validation-rule-from-nl-v1',
      // PR 13.1: prompt caching. systemPrompt is content-static across
      // invocations (declared as a function-local const but identical
      // every call — Anthropic's cache key is content-hash-based, not
      // declaration-location-based). EMIT_VALIDATION_RULE_TOOL adds
      // ~2.5K tk of cacheable tool definition.
      cacheControl: true,
      abuseUserId: user.id,
      metadata: { field_id: fieldId, table_id: tableId },
      ...(phase2Enabled && { tool: EMIT_VALIDATION_RULE_TOOL }),
    })
    llmCallId = result.callId
    if (result.kind === 'toolUse') {
      parsed = result.toolUse.input as typeof parsed
    } else {
      const cleaned = result.text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()
      parsed = JSON.parse(cleaned)
    }
  } catch {
    return { success: false, error: 'AI returned an unexpected response. Please try again.' }
  }

  if (!parsed.name || !parsed.rule_type || !parsed.rule_config) {
    return { success: false, error: 'AI response was incomplete. Please try again.' }
  }

  // Fix 2: validate AI-generated rule_config shape before saving
  const configError = validateRuleConfig(parsed.rule_type, parsed.rule_config)
  if (configError) {
    return {
      success: false,
      error: `AI generated an invalid rule config: ${configError}. Please try again with a clearer description.`,
    }
  }

  // Fix 1: use RLS client for validation_rules INSERT
  const { data, error } = await supabase
    .from('validation_rules')
    .insert({
      project_id: projectId,
      field_id: fieldId,
      table_id: tableId,
      name: parsed.name,
      description:
        parsed.description ?? generateRuleDescription(parsed.rule_type, parsed.rule_config),
      rule_type: parsed.rule_type,
      rule_config: parsed.rule_config,
      severity: severityOverride ?? parsed.severity ?? 'warning',
      is_ai_generated: true,
      ai_original_prompt: naturalLanguageRule,
    })
    .select()
    .single()

  if (error) return { success: false, error: error.message }

  const savedRule = data as ValidationRule
  await logActivity(
    projectId,
    'rule_added',
    `Validation rule added: ${savedRule.name}`,
    'validation',
    { validation_rule_id: savedRule.id, rule_type: savedRule.rule_type, ai_generated: true }
  )

  // Provenance: AI-proposed rule. llmCallId chains back to the callLLM
  // result so eval-export and confidence-calibration paths can join
  // ai_edit_history → llm_calls.
  void logAIEdit({
    projectId,
    actorId: user.id,
    entityType: 'validation_rule',
    entityId: savedRule.id,
    fieldPath: 'rule_config',
    oldValue: null,
    newValue: {
      name: parsed.name,
      rule_type: parsed.rule_type,
      rule_config: parsed.rule_config,
      severity: severityOverride ?? parsed.severity ?? 'warning',
    },
    editKind: 'ai_proposed',
    llmCallId,
    metadata: {
      table_id: tableId,
      field_id: fieldId,
      ai_original_prompt: naturalLanguageRule,
    },
  })

  return { success: true, rule: savedRule }
}

// Maps a validation rule_type to the machine-readable issue_kind we record
// on quality_issues. Populated so the Validate page can render a stable
// chip-3 label via buildContextualLabel without fragile description matching.
// Keys MUST match the rule_type strings handled in the switch below.
const RULE_TYPE_TO_ISSUE_KIND: Record<string, string> = {
  allowed_values: 'value_not_in_allowed_list',
  not_null: 'null_required',
  regex: 'format_violation',
  min_length: 'length_violation',
  max_length: 'length_violation',
  min_value: 'range_violation',
  max_value: 'range_violation',
  range: 'range_violation',
  date_after: 'range_violation',
  date_before: 'range_violation',
  unique: 'duplicate_value',
  custom_sql: 'custom_rule_violation',
}

// ── execute custom rules for a table ─────────────────────────────────────────

export async function executeCustomRules(
  projectId: string,
  tableId: string
): Promise<{ success: boolean; newIssues: number; warnings: string[]; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, newIssues: 0, warnings: [], error: 'Not authenticated' }

  // Fix 1: use RLS client for tables and datasets — they have proper RLS policies
  const { data: tableData } = await supabase
    .from('tables')
    .select('name, dataset_id, datasets!inner(role)')
    .eq('id', tableId)
    .single()

  if (!tableData) return { success: false, newIssues: 0, warnings: [], error: 'Table not found' }
  const tableName = tableData.name
  const datasetRole = (tableData as unknown as { datasets: { role: string } }).datasets?.role ?? 'source'

  // Look up table_mapping_id — join column differs for source vs target tables
  let tableMappingId: string | null = null
  let hasStaged = false

  const mappingColumn = datasetRole === 'source' ? 'source_table_id' : 'target_table_id'
  const { data: tMapping } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq(mappingColumn, tableId)
    .eq('project_id', projectId)
    .maybeSingle()

  tableMappingId = tMapping?.id ?? null

  if (tableMappingId) {
    const { count: stagedCount } = await supabaseAdmin
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', tableMappingId)
      .limit(1)
    hasStaged = (stagedCount ?? 0) > 0
  }

  // Target tables have no rows in data_rows — skip entirely until staged
  if (datasetRole === 'target' && !hasStaged) {
    console.log(`[executeCustomRules] Skipping rules for target table ${tableName} (${tableId}) — not yet staged`)
    return { success: true, newIssues: 0, warnings: [] }
  }

  // Stage is determined strictly by dataset role: source-table rules always
  // produce source-stage issues (they belong in Data Profiling), target-table
  // rules always produce in-flight issues (they belong in Validate). Staging
  // state is NOT part of this decision — a source table with a staged
  // mapping is still reporting source observations.
  const stage: 'source' | 'in_flight' =
    datasetRole === 'target' ? 'in_flight' : 'source'

  // Fix 1: use RLS client for validation_rules SELECT
  const { data: allMatchedRules } = await supabase
    .from('validation_rules')
    .select('*')
    .eq('project_id', projectId)
    .or(`table_id.eq.${tableId},table_id.is.null`)

  if (!allMatchedRules || allMatchedRules.length === 0) return { success: true, newIssues: 0, warnings: [] }

  // Fix 1: use RLS client for fields SELECT
  const { data: tableFields } = await supabase
    .from('fields')
    .select('id')
    .eq('table_id', tableId)
  const tableFieldIds = new Set((tableFields ?? []).map((f) => f.id))

  const rules = (allMatchedRules as ValidationRule[]).filter((rule) => {
    if (rule.table_id === tableId) return true
    if (!rule.table_id && rule.field_id && tableFieldIds.has(rule.field_id)) return true
    return false
  })

  if (rules.length === 0) return { success: true, newIssues: 0, warnings: [] }

  // ───────────────────────────────────────────────────────────────────────────
  // Guard-wiring decision (Prompt 3d, Step 3D-7, 2026-04-22): no
  // `assertMappingWritesEnabled` guard on the block below. The writes in
  // executeCustomRules land on `quality_issues` and `validation_rules` —
  // NOT on the mapping-shape surface (`target_field_mappings` /
  // `mapping_sources`). Maintenance mode guards mapping-shape mutations
  // only; quality-detection output must continue to flow during
  // maintenance so scans stay usable.
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Batch-fetch TFM + MS + transformations for every rule that targets a
  // field, so we can attribute root_cause_breakdown at insert time without
  // a per-issue round-trip. Rules can be attached to either a source field
  // (custom user rules, matched via mapping_sources.source_field_id) or a
  // target field (DDL-seeded CHECK-constraint rules, matched via
  // target_field_mappings.target_field_id). Both paths flatten into a
  // single `fmByFieldId: field_id → { id: target_field_mapping_id }` map
  // so downstream attribution logic stays identical to the legacy shape.
  const ruleFieldIds = rules
    .map((r) => r.field_id)
    .filter((id): id is string => Boolean(id))

  type TfmRef = { id: string }
  const fmByFieldId = new Map<string, TfmRef>()
  let tfmIds: string[] = []

  if (ruleFieldIds.length > 0) {
    // (a) Source-side: a mapping_source whose source_field_id matches a rule
    //     field, with the owning TFM joined for project scoping + status
    //     filtering. A source field can back multiple TFMs (primary in one,
    //     contributor in another); Map.set last-wins is preserved from the
    //     legacy behaviour — same non-determinism, same downstream effect.
    const { data: msSourceRows } = await supabaseAdmin
      .from('mapping_sources')
      .select(
        `
        source_field_id,
        target_field_mapping:target_field_mappings!inner (
          id, project_id, status
        )
      `
      )
      .in('source_field_id', ruleFieldIds)
      .eq('target_field_mapping.project_id', projectId)
      .neq('target_field_mapping.status', 'rejected')

    // (b) Target-side: a TFM whose target_field_id matches a rule field.
    //     target_field_id is unique per TFM, so at most one TFM per rule
    //     field — no ambiguity on this side.
    const { data: tfmTargetRows } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, target_field_id')
      .in('target_field_id', ruleFieldIds)
      .eq('project_id', projectId)
      .neq('status', 'rejected')

    type MsJoinRow = {
      source_field_id: string | null
      target_field_mapping:
        | { id: string; project_id: string; status: string }
        | { id: string; project_id: string; status: string }[]
        | null
    }
    const pickTfm = (r: MsJoinRow) => {
      const v = r.target_field_mapping
      if (!v) return null
      return Array.isArray(v) ? v[0] ?? null : v
    }

    for (const row of (msSourceRows ?? []) as MsJoinRow[]) {
      const tfm = pickTfm(row)
      if (!tfm || !row.source_field_id) continue
      if (!ruleFieldIds.includes(row.source_field_id)) continue
      fmByFieldId.set(row.source_field_id, { id: tfm.id })
    }

    for (const tfm of tfmTargetRows ?? []) {
      if (!tfm.target_field_id) continue
      if (!ruleFieldIds.includes(tfm.target_field_id)) continue
      fmByFieldId.set(tfm.target_field_id as string, { id: tfm.id as string })
    }

    tfmIds = [
      ...new Set([
        ...((msSourceRows ?? []) as MsJoinRow[])
          .map((r) => pickTfm(r)?.id)
          .filter((id): id is string => Boolean(id)),
        ...(tfmTargetRows ?? []).map((t) => t.id as string),
      ]),
    ]
  }

  const txByTfmId = new Map<string, { status: string }>()
  if (tfmIds.length > 0) {
    const { data: txRows } = await supabaseAdmin
      .from('transformations')
      .select('target_field_mapping_id, status')
      .in('target_field_mapping_id', tfmIds)
    for (const tx of txRows ?? []) {
      txByTfmId.set(tx.target_field_mapping_id as string, { status: tx.status as string })
    }
  }

  // Helper: run a rule via dq_custom_rule_staged RPC
  async function stagedCount(
    fieldName: string,
    operator: string,
    value?: string | null
  ): Promise<number> {
    const { data: cnt } = await supabaseAdmin.rpc('dq_custom_rule_staged', {
      p_table_mapping_id: tableMappingId,
      p_field_name: fieldName,
      p_operator: operator,
      p_value: value ?? null,
    })
    return Number(cnt ?? 0)
  }

  const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []
  const warnings: string[] = []

  for (const rule of rules as ValidationRule[]) {
    let violationCount = 0
    const fieldId = rule.field_id

    let fieldName = 'unknown'
    if (fieldId) {
      // Fix 1: use RLS client for field name lookup
      const { data: fieldRow } = await supabase
        .from('fields')
        .select('name')
        .eq('id', fieldId)
        .single()
      if (fieldRow) fieldName = fieldRow.name
    }

    const cfg = rule.rule_config as Record<string, unknown>

    try {
      switch (rule.rule_type) {
        case 'not_null':
          if (fieldId) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              violationCount = await stagedCount(fieldName, 'is_null')
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_null_count', {
                p_table_id: tableId,
                p_field: fieldName,
              })
              violationCount = Number(cnt ?? 0)
            }
            // Target table, not staged: nothing to check — violationCount stays 0
          }
          break

        case 'unique':
          // Uniqueness check against staged_data_rows is not yet supported
          if (fieldId && datasetRole === 'source') {
            const { data: cnt } = await supabaseAdmin.rpc('dq_duplicate_count', {
              p_table_id: tableId,
              p_field: fieldName,
            })
            violationCount = Number(cnt ?? 0)
          }
          break

        case 'min_value':
          if (fieldId && cfg.min !== undefined) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              violationCount = await stagedCount(fieldName, 'less_than', String(cfg.min))
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_below_min_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_min: Number(cfg.min),
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'max_value':
          if (fieldId && cfg.max !== undefined) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              violationCount = await stagedCount(fieldName, 'greater_than', String(cfg.max))
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_above_max_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_max: Number(cfg.max),
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'min_length':
          if (fieldId && cfg.min_length !== undefined) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              violationCount = await stagedCount(fieldName, 'below_min_length', String(cfg.min_length))
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_below_min_length_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_min_length: Number(cfg.min_length),
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'max_length':
          if (fieldId && cfg.max_length !== undefined) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              violationCount = await stagedCount(fieldName, 'above_max_length', String(cfg.max_length))
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_length_exceeded_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_max: Number(cfg.max_length),
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'allowed_values':
          if (fieldId && Array.isArray(cfg.values) && cfg.values.length > 0) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              // Staged path: evaluates transformed_row_data (with source fallback)
              // via dq_custom_rule_staged's 'not_in_list' operator (migration 065).
              // Target-only — source-table rules use the source-data RPC below
              // so they produce stage='source' issues visible in Data Profiling.
              violationCount = await stagedCount(
                fieldName,
                'not_in_list',
                JSON.stringify(cfg.values as string[])
              )
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_not_in_allowed_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_values: cfg.values as string[],
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'regex':
          if (fieldId && cfg.pattern) {
            if (hasStaged && tableMappingId && datasetRole === 'target') {
              // not_matches_regex counts rows that DON'T match — i.e., violations
              violationCount = await stagedCount(fieldName, 'not_matches_regex', String(cfg.pattern))
            } else if (datasetRole === 'source') {
              const { data: cnt } = await supabaseAdmin.rpc('dq_regex_mismatch_count', {
                p_table_id: tableId,
                p_field: fieldName,
                p_pattern: String(cfg.pattern),
              })
              violationCount = Number(cnt ?? 0)
            }
          }
          break

        case 'custom_sql':
          // custom_sql operates on data_rows — source only
          if (cfg.sql && datasetRole === 'source') {
            const sqlStr = String(cfg.sql)
            const validation = validateFixSQL(sqlStr, tableId)
            if (!validation.safe) break
            try {
              const { data: cnt } = await supabaseAdmin.rpc('execute_data_fix', {
                p_sql: sqlStr,
                p_table_id: tableId,
              })
              violationCount = Number(cnt ?? 0)
            } catch {
              // Ignore errors from invalid custom SQL
            }
          }
          break

        default:
          continue
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[validation-rules] Rule "${rule.name}" (${rule.rule_type}) failed on field "${fieldName}":`, errMsg)
      warnings.push(
        `Rule "${rule.name}" could not be evaluated on ${tableName}.${fieldName}: ${
          errMsg.toLowerCase().includes('numeric') || errMsg.toLowerCase().includes('invalid input syntax')
            ? 'field contains non-numeric values (e.g. currency symbols or text)'
            : errMsg
        }`
      )
      continue
    }

    if (violationCount > 0) {
      // Root cause attribution:
      //   - unique / custom_sql / no field_id → always source_data
      //   - field with an applied transform → transform_error (transform didn't
      //     fully resolve the issue)
      //   - field with a mapping but no applied transform → missing_transform
      //   - field with no mapping info → source_data (best-effort fallback)
      let rootCauseBreakdown: {
        source_data: number
        transform_error: number
        missing_transform: number
      } = { source_data: violationCount, transform_error: 0, missing_transform: 0 }

      if (
        rule.rule_type !== 'unique' &&
        rule.rule_type !== 'custom_sql' &&
        fieldId
      ) {
        const fm = fmByFieldId.get(fieldId)
        if (fm) {
          const hasApplied = txByTfmId.get(fm.id)?.status === 'applied'
          if (hasApplied) {
            rootCauseBreakdown = {
              source_data: 0,
              transform_error: violationCount,
              missing_transform: 0,
            }
          } else {
            rootCauseBreakdown = {
              source_data: 0,
              transform_error: 0,
              missing_transform: violationCount,
            }
          }
        }
      }

      issuesToInsert.push({
        project_id: projectId,
        table_id: tableId,
        field_id: fieldId,
        stage,
        severity: rule.severity,
        title: `${tableName}.${fieldName}`,
        description: rule.description ?? generateRuleDescription(rule.rule_type, cfg),
        affected_records: violationCount,
        ai_suggested_fix: null,
        ai_fix_options: null,
        downstream_impact: null,
        affected_rows_sample: null,
        generated_sql: null,
        status: 'open',
        detection_source: 'custom_rule',
        validation_rule_id: rule.id,
        issue_kind: RULE_TYPE_TO_ISSUE_KIND[rule.rule_type] ?? null,
        root_cause_breakdown: rootCauseBreakdown,
      })
    }
  }

  // Delete any pre-existing custom_rule issues for the specific rules we just
  // evaluated before inserting fresh ones. This prevents:
  //   (a) duplicates from repeated scans / "Run rule" clicks — executeCustomRules
  //       has no upsert logic, so each invocation would otherwise append;
  //   (b) stale issues for rules that now pass — if a rule previously produced
  //       violations but currently finds none, its old quality_issues row would
  //       linger as a ghost. Scoped by validation_rule_id so we don't disturb
  //       issues tied to other rules (including in runFullScan's loop over
  //       many tables).
  const evaluatedRuleIds = (rules as ValidationRule[]).map((r) => r.id)
  if (evaluatedRuleIds.length > 0) {
    await supabaseAdmin
      .from('quality_issues')
      .delete()
      .eq('project_id', projectId)
      .eq('detection_source', 'custom_rule')
      .in('validation_rule_id', evaluatedRuleIds)
  }

  if (issuesToInsert.length > 0) {
    // Fix 1: use RLS client for quality_issues INSERT
    const { error } = await supabase.from('quality_issues').insert(issuesToInsert)
    if (error) return { success: false, newIssues: 0, warnings, error: error.message }
  }

  return { success: true, newIssues: issuesToInsert.length, warnings }
}

// ── delete a rule ─────────────────────────────────────────────────────────────

export async function deleteValidationRule(
  ruleId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // Fix 1: use RLS client — validation_rules RLS enforces project ownership
  const { data: rule } = await supabase
    .from('validation_rules')
    .select('project_id, name, rule_type, projects!inner(user_id)')
    .eq('id', ruleId)
    .single()

  if (!rule) return { success: false, error: 'Rule not found' }
  if ((rule as unknown as { projects: { user_id: string } }).projects?.user_id !== user.id) {
    return { success: false, error: 'Access denied' }
  }

  await supabase.from('validation_rules').delete().eq('id', ruleId)

  await logActivity(
    rule.project_id,
    'rule_deleted',
    `Validation rule deleted: ${rule.name}`,
    'validation',
    { validation_rule_id: ruleId, rule_type: rule.rule_type }
  )

  // Provenance: deletion is a human_rejected event whether the rule was
  // AI-proposed or user-authored. Old value snapshot captures the
  // pre-delete shape so the calibration path can correlate.
  void logAIEdit({
    projectId: rule.project_id,
    actorId: user.id,
    entityType: 'validation_rule',
    entityId: ruleId,
    fieldPath: 'rule_config',
    oldValue: { name: rule.name, rule_type: rule.rule_type },
    newValue: null,
    editKind: 'human_rejected',
  })

  return { success: true }
}

// ── get all validation rules for a project ────────────────────────────────────

export async function getValidationRules(projectId: string): Promise<ValidationRule[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data } = await supabase
    .from('validation_rules')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  return (data as ValidationRule[]) ?? []
}
