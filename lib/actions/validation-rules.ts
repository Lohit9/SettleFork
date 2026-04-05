'use server'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { validateFixSQL } from '@/lib/quality/fix-sql-validator'
import { logActivity } from '@/lib/actions/activity-log'
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

  await logActivity(
    projectId,
    'rule_added',
    `Validation rule added: ${rule.name}`,
    'validation',
    { validation_rule_id: (data as ValidationRule).id, rule_type: rule.rule_type }
  )

  return { success: true, rule: data as ValidationRule }
}

// ── add a rule from natural language ─────────────────────────────────────────

export async function addValidationRuleFromNL(
  projectId: string,
  fieldId: string,
  naturalLanguageRule: string,
  severityOverride?: 'blocking' | 'warning'
): Promise<{ success: boolean; rule?: ValidationRule; error?: string }> {
  // Fix 5: fieldId is required for NL rules
  if (!fieldId) {
    return { success: false, error: 'Must select a field for the validation rule' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

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

  let parsed: {
    name: string
    description: string
    rule_type: string
    rule_config: Record<string, unknown>
    severity: 'blocking' | 'warning'
  }

  try {
    const raw = await callClaude(systemPrompt, userMessage, 512)
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    parsed = JSON.parse(cleaned)
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

  return { success: true, rule: savedRule }
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
  const stage: 'source' | 'in_flight' = datasetRole === 'source' ? 'source' : 'in_flight'

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
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_null_count', {
            p_table_id: tableId,
            p_field: fieldName,
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'unique':
        if (fieldId) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_duplicate_count', {
            p_table_id: tableId,
            p_field: fieldName,
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'min_value':
        if (fieldId && cfg.min !== undefined) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_below_min_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_min: Number(cfg.min),
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'max_value':
        if (fieldId && cfg.max !== undefined) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_above_max_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_max: Number(cfg.max),
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'min_length':
        if (fieldId && cfg.min_length !== undefined) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_below_min_length_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_min_length: Number(cfg.min_length),
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'max_length':
        if (fieldId && cfg.max_length !== undefined) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_length_exceeded_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_max: Number(cfg.max_length),
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'allowed_values':
        if (fieldId && Array.isArray(cfg.values) && cfg.values.length > 0) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_not_in_allowed_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_values: cfg.values as string[],
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'regex':
        if (fieldId && cfg.pattern) {
          // Admin required: SECURITY DEFINER RPC that reads data_rows
          const { data: cnt } = await supabaseAdmin.rpc('dq_regex_mismatch_count', {
            p_table_id: tableId,
            p_field: fieldName,
            p_pattern: String(cfg.pattern),
          })
          violationCount = Number(cnt ?? 0)
        }
        break

      case 'custom_sql':
        if (cfg.sql) {
          const sqlStr = String(cfg.sql)
          const validation = validateFixSQL(sqlStr, tableId)
          if (!validation.safe) break
          try {
            // Admin required: SECURITY DEFINER RPC that reads data_rows
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
      })
    }
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
