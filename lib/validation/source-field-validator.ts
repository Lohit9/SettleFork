/**
 * Layer 2 data quality checks on source field profiles (S1 — Task #16).
 *
 * Pure, deterministic checks over FieldContext data that is already fetched
 * by buildAIContext. No LLM calls, no DB writes, no side effects.
 *
 * Called from formatSchemaForPrompt so the mapping agent sees structured
 * DQ warnings alongside raw profiling stats. Helps the LLM make better
 * mapping decisions (e.g. avoid mapping a 90%-null field to a NOT NULL
 * target without a COALESCE).
 *
 * Checks:
 *   1. high_null_rate        — >80% null; risky to map to NOT NULL targets
 *   2. type_mismatch         — inferred_type ≠ data_type; likely needs CAST
 *   3. format_issues_present — non-zero format_issues_count; input sanitization needed
 *   4. low_cardinality_pk    — PK with <10 distinct values; uniqueness suspect
 *   5. constant_field        — cardinality=1, 0% null; likely misconfigured or constant
 */

import type { FieldContext } from '@/lib/ai/context-builder'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SourceFieldCheckId =
  | 'high_null_rate'
  | 'type_mismatch'
  | 'format_issues_present'
  | 'low_cardinality_pk'
  | 'constant_field'

export interface SourceFieldIssue {
  check: SourceFieldCheckId
  severity: 'warning' | 'info'
  message: string
  suggestion?: string
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const HIGH_NULL_THRESHOLD = 80   // percent
const LOW_CARDINALITY_PK_THRESHOLD = 10  // distinct values

// ─── Individual checks ───────────────────────────────────────────────────────

function checkHighNullRate(field: FieldContext): SourceFieldIssue | null {
  if (field.null_percentage <= HIGH_NULL_THRESHOLD) return null
  return {
    check: 'high_null_rate',
    severity: 'warning',
    message: `${field.null_percentage.toFixed(1)}% null`,
    suggestion: `Cannot map to NOT NULL target without COALESCE or a default value.`,
  }
}

function checkTypeMismatch(field: FieldContext): SourceFieldIssue | null {
  if (!field.inferred_type) return null
  // Normalize both sides to lowercase for comparison
  const declared = field.data_type.toLowerCase().split('(')[0].trim()
  const inferred = field.inferred_type.toLowerCase().split('(')[0].trim()
  if (declared === inferred) return null
  // Common equivalences that are not real mismatches
  const EQUIVALENT_PAIRS = new Set([
    'character varying:text',
    'varchar:text',
    'character varying:varchar',
    'integer:int',
    'integer:int4',
    'bigint:int8',
    'boolean:bool',
    'double precision:float8',
    'real:float4',
    'numeric:decimal',
  ])
  const pairKey = `${declared}:${inferred}`
  const pairKeyRev = `${inferred}:${declared}`
  if (EQUIVALENT_PAIRS.has(pairKey) || EQUIVALENT_PAIRS.has(pairKeyRev)) return null

  return {
    check: 'type_mismatch',
    severity: 'warning',
    message: `Declared ${field.data_type} but inferred as ${field.inferred_type}`,
    suggestion: `Verify whether a CAST is needed in the transform SQL.`,
  }
}

function checkFormatIssues(field: FieldContext): SourceFieldIssue | null {
  if (!field.format_issues_count || field.format_issues_count === 0) return null
  return {
    check: 'format_issues_present',
    severity: 'warning',
    message: `${field.format_issues_count} format issue(s) detected`,
    suggestion: `Transform SQL may need input sanitization (e.g. TRIM, REGEXP_REPLACE, NULLIF).`,
  }
}

function checkLowCardinalityPk(field: FieldContext): SourceFieldIssue | null {
  if (!field.is_primary_key) return null
  if (!field.cardinality || field.cardinality === 0) return null
  if (field.cardinality >= LOW_CARDINALITY_PK_THRESHOLD) return null
  return {
    check: 'low_cardinality_pk',
    severity: 'warning',
    message: `Primary key has only ${field.cardinality} distinct value(s)`,
    suggestion: `Uniqueness constraint may not hold — verify this is a true PK before mapping.`,
  }
}

function checkConstantField(field: FieldContext): SourceFieldIssue | null {
  if (!field.cardinality || field.cardinality !== 1) return null
  if (field.null_percentage > 0) return null
  if (field.is_primary_key) return null  // low_cardinality_pk already fires
  return {
    check: 'constant_field',
    severity: 'info',
    message: `Single distinct value across all rows`,
    suggestion: `May be a constant column or misconfigured default — consider using a literal in the transform instead of row_data reference.`,
  }
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Run all Layer 2 DQ checks on a single source field.
 * Returns an empty array when the field is clean.
 */
export function validateSourceField(field: FieldContext): SourceFieldIssue[] {
  const issues: SourceFieldIssue[] = []
  const checks = [
    checkHighNullRate,
    checkTypeMismatch,
    checkFormatIssues,
    checkLowCardinalityPk,
    checkConstantField,
  ]
  for (const check of checks) {
    const issue = check(field)
    if (issue) issues.push(issue)
  }
  return issues
}

/**
 * Run all Layer 2 DQ checks on a list of source fields.
 * Returns a Map keyed by field_id → issues array.
 * Fields with no issues are omitted from the map.
 */
export function validateSourceFields(fields: FieldContext[]): Map<string, SourceFieldIssue[]> {
  const result = new Map<string, SourceFieldIssue[]>()
  for (const field of fields) {
    const issues = validateSourceField(field)
    if (issues.length > 0) result.set(field.field_id, issues)
  }
  return result
}
