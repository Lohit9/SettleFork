/**
 * Deterministic mapping validation layer.
 *
 * Runs BEFORE any human sees a proposed mapping. Every check is pure
 * logic — no LLM calls, no network, no side effects. Returns a typed
 * result the UI can render and the agent loop can consume for self-correction.
 *
 * Principle: AI proposes → THIS validates → Human approves.
 * The human should never be asked to catch something this module can prove.
 *
 * Complements (does NOT replace) the existing quality engine at
 * lib/quality/_detection-engine-core.ts, which runs AFTER staging.
 * This module runs BEFORE staging — on the mapping itself, not on data.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  /** Unique check identifier for programmatic handling. */
  check: ValidationCheckId
  severity: ValidationSeverity
  /** Human-readable one-liner. */
  message: string
  /** Structured detail for the UI drawer. */
  detail?: string
  /** The source field(s) involved. */
  sourceFields?: string[]
  /** The target field involved. */
  targetField?: string
  /** Suggested fix (for agent self-correction loop). */
  suggestion?: string
}

export type ValidationCheckId =
  | 'type_incompatible'
  | 'type_precision_loss'
  | 'type_width_truncation'
  | 'null_to_not_null'
  | 'unique_violation_risk'
  | 'fk_orphan_risk'
  | 'fk_circular_dependency'
  | 'fk_load_order_violation'
  | 'enum_mismatch'
  | 'unmapped_required_target'
  | 'many_to_one_collision'
  | 'timezone_coercion'
  | 'fk_value_gap'

export interface ValidationResult {
  /** True if zero errors (warnings are OK). */
  valid: boolean
  issues: ValidationIssue[]
  /** Counts by severity for summary display. */
  counts: { errors: number; warnings: number; info: number }
}

// ─── Field shapes (minimal projection) ──────────────────────────────

export interface SourceField {
  name: string
  dataType: string
  isNullable: boolean
  /** Distinct value count from profiling (null if not profiled). */
  distinctCount?: number | null
  /** Max observed length for string fields (null if not profiled). */
  maxLength?: number | null
  /** Null percentage from profiling (0-100). */
  nullPct?: number | null
  /** Sample values from profiling. */
  sampleValues?: string[]
  /** Whether the source datetime values include timezone info (null if not profiled). */
  hasTimezone?: boolean | null
}

export interface TargetField {
  name: string
  dataType: string
  isNullable: boolean
  isPrimaryKey: boolean
  isUnique: boolean
  isForeignKey: boolean
  fkReference: string | null
  /** Max allowed length for string fields (parsed from type like VARCHAR(40)). */
  maxLength?: number | null
  /** Allowed enum values if the field is constrained. */
  enumValues?: string[]
  /** Known values in the FK lookup table (null if not a FK or not profiled). */
  fkLookupValues?: string[] | null
}

export interface MappingProposal {
  sourceFields: SourceField[]
  targetField: TargetField
  transformSql?: string | null
}

// ─── Type compatibility ─────────────────────────────────────────────

const TYPE_FAMILIES: Record<string, string> = {
  // String family
  varchar: 'string', char: 'string', text: 'string', nvarchar: 'string', nchar: 'string',
  // Integer family
  int: 'integer', integer: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer', serial: 'integer',
  // Decimal family
  decimal: 'decimal', numeric: 'decimal', float: 'decimal', double: 'decimal', real: 'decimal', money: 'decimal',
  // Boolean
  boolean: 'boolean', bool: 'boolean', bit: 'boolean',
  // Date/time
  date: 'date', datetime: 'datetime', timestamp: 'datetime', timestamptz: 'datetime', time: 'time',
  // UUID
  uuid: 'uuid',
  // JSON
  json: 'json', jsonb: 'json',
}

function parseBaseType(dataType: string): string {
  const lower = dataType.toLowerCase().trim()
  const base = lower.split(/[(\s]/)[0]
  return TYPE_FAMILIES[base] || base
}

function parseMaxLength(dataType: string): number | null {
  const match = dataType.match(/\((\d+)\)/)
  return match ? parseInt(match[1], 10) : null
}

/** Lossy coercions that silently destroy data. */
const INCOMPATIBLE_PAIRS: Array<[string, string]> = [
  ['string', 'boolean'],
  ['datetime', 'boolean'],
  ['json', 'integer'],
  ['json', 'boolean'],
]

/** Coercions that lose precision but don't fail. */
const PRECISION_LOSS_PAIRS: Array<[string, string]> = [
  ['decimal', 'integer'],  // 3.14 → 3
  ['datetime', 'date'],    // loses time component
  ['bigint', 'integer'],   // overflow risk
  ['integer', 'boolean'],  // 0/1 ok, anything else loses info
]

// ─── Individual checks ──────────────────────────────────────────────

function checkTypeCompatibility(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  // Skip if transform SQL exists — the transform handles type conversion
  if (proposal.transformSql) return issues

  for (const src of proposal.sourceFields) {
    const srcFamily = parseBaseType(src.dataType)
    const tgtFamily = parseBaseType(proposal.targetField.dataType)

    if (srcFamily === tgtFamily) continue

    const isIncompatible = INCOMPATIBLE_PAIRS.some(
      ([a, b]) => (srcFamily === a && tgtFamily === b) || (srcFamily === b && tgtFamily === a)
    )

    if (isIncompatible) {
      issues.push({
        check: 'type_incompatible',
        severity: 'error',
        message: `${src.name} (${src.dataType}) → ${proposal.targetField.name} (${proposal.targetField.dataType}): incompatible types`,
        sourceFields: [src.name],
        targetField: proposal.targetField.name,
        suggestion: `Add a CAST or transformation SQL to convert ${srcFamily} to ${tgtFamily}`,
      })
    } else {
      const lossy = PRECISION_LOSS_PAIRS.some(
        ([a, b]) => srcFamily === a && tgtFamily === b
      )
      if (lossy) {
        issues.push({
          check: 'type_precision_loss',
          severity: 'warning',
          message: `${src.name} (${src.dataType}) → ${proposal.targetField.name} (${proposal.targetField.dataType}): precision loss`,
          sourceFields: [src.name],
          targetField: proposal.targetField.name,
          suggestion: `Consider a rounding/truncation transform to make the conversion explicit`,
        })
      }
    }
  }
  return issues
}

function checkWidthTruncation(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (proposal.transformSql) return issues

  const targetMax = proposal.targetField.maxLength ?? parseMaxLength(proposal.targetField.dataType)
  if (!targetMax) return issues

  for (const src of proposal.sourceFields) {
    const srcMax = src.maxLength ?? parseMaxLength(src.dataType)
    if (srcMax && srcMax > targetMax) {
      issues.push({
        check: 'type_width_truncation',
        severity: 'warning',
        message: `${src.name} (max ${srcMax} chars) → ${proposal.targetField.name} (max ${targetMax} chars): data may be silently truncated`,
        detail: src.maxLength
          ? `Profiled max observed length: ${src.maxLength}. Target allows ${targetMax}.`
          : `Source type allows ${srcMax} chars. Target allows ${targetMax}.`,
        sourceFields: [src.name],
        targetField: proposal.targetField.name,
        suggestion: `Add LEFT(${src.name}, ${targetMax}) or validate no values exceed ${targetMax} chars`,
      })
    }
  }
  return issues
}

function checkNullViolation(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (proposal.targetField.isNullable) return issues

  for (const src of proposal.sourceFields) {
    if (src.isNullable && (src.nullPct === undefined || src.nullPct === null || src.nullPct > 0)) {
      issues.push({
        check: 'null_to_not_null',
        severity: 'error',
        message: `${src.name} contains nulls → ${proposal.targetField.name} is NOT NULL`,
        detail: src.nullPct != null
          ? `Source has ${src.nullPct.toFixed(1)}% null values. Target rejects nulls.`
          : `Source field is nullable. Target field is NOT NULL. Run profiling to check actual null rate.`,
        sourceFields: [src.name],
        targetField: proposal.targetField.name,
        suggestion: `Add COALESCE(${src.name}, '<default>') to handle nulls`,
      })
    }
  }
  return issues
}

function checkUniqueViolation(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!proposal.targetField.isUnique && !proposal.targetField.isPrimaryKey) return issues

  // Multi-source → single unique target = guaranteed collision
  if (proposal.sourceFields.length > 1) {
    issues.push({
      check: 'many_to_one_collision',
      severity: 'error',
      message: `${proposal.sourceFields.length} source fields → ${proposal.targetField.name} (UNIQUE): merge will produce duplicates`,
      sourceFields: proposal.sourceFields.map(f => f.name),
      targetField: proposal.targetField.name,
      suggestion: `Use CONCAT or a transformation to produce unique values from the merged sources`,
    })
  }

  // Single source but not distinct enough
  for (const src of proposal.sourceFields) {
    if (src.distinctCount != null && src.distinctCount < (src.maxLength ?? Infinity)) {
      // This is a weak heuristic — real check needs row count vs distinct count
      // For now, flag if profiling data suggests non-unique values exist
    }
  }

  return issues
}

function checkEnumMismatch(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const enums = proposal.targetField.enumValues
  if (!enums || enums.length === 0) return issues

  for (const src of proposal.sourceFields) {
    if (src.sampleValues && src.sampleValues.length > 0) {
      const mismatches = src.sampleValues.filter(v => !enums.includes(v))
      if (mismatches.length > 0) {
        issues.push({
          check: 'enum_mismatch',
          severity: 'warning',
          message: `${src.name} has values not in ${proposal.targetField.name}'s allowed set`,
          detail: `Values not in enum: ${mismatches.slice(0, 5).join(', ')}${mismatches.length > 5 ? '...' : ''}. Allowed: ${enums.join(', ')}`,
          sourceFields: [src.name],
          targetField: proposal.targetField.name,
          suggestion: `Add a CASE WHEN transform to map source values to the target enum`,
        })
      }
    }
  }
  return issues
}

// ─── Timezone-aware types ───────────────────────────────────────────

/** Types that carry timezone info vs types that don't. */
const TZ_AWARE_TYPES = new Set(['timestamptz', 'datetimeoffset', 'timestamp with time zone'])
const TZ_NAIVE_TYPES = new Set(['datetime', 'timestamp', 'datetime2', 'smalldatetime'])

function isTimezoneAware(dataType: string): boolean | null {
  const lower = dataType.toLowerCase().trim()
  if (TZ_AWARE_TYPES.has(lower)) return true
  if (TZ_NAIVE_TYPES.has(lower)) return false
  return null
}

function checkTimezoneCoercion(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (proposal.transformSql) return issues

  const tgtFamily = parseBaseType(proposal.targetField.dataType)
  if (tgtFamily !== 'datetime') return issues

  const targetTzAware = isTimezoneAware(proposal.targetField.dataType)

  for (const src of proposal.sourceFields) {
    const srcFamily = parseBaseType(src.dataType)
    if (srcFamily !== 'datetime') continue

    const sourceTzAware = isTimezoneAware(src.dataType)

    // Naive → TZ-aware: silent reinterpretation as UTC (or server TZ)
    if (sourceTzAware === false && targetTzAware === true) {
      issues.push({
        check: 'timezone_coercion',
        severity: 'warning',
        message: `${src.name} (${src.dataType}) → ${proposal.targetField.name} (${proposal.targetField.dataType}): no timezone in source, target expects timezone`,
        detail: src.hasTimezone === false
          ? `Profiling confirms source values have no timezone offset. They will be silently interpreted as UTC (or the target DB's default timezone), which may shift every timestamp.`
          : `Source type has no timezone component. If values represent local time, they will be silently reinterpreted. Run profiling to check for timezone offsets in the data.`,
        sourceFields: [src.name],
        targetField: proposal.targetField.name,
        suggestion: `Add AT TIME ZONE '<source_timezone>' to explicitly declare the source timezone before casting to ${proposal.targetField.dataType}`,
      })
    }

    // TZ-aware → naive: silently drops timezone (may shift values if not UTC)
    if (sourceTzAware === true && targetTzAware === false) {
      issues.push({
        check: 'timezone_coercion',
        severity: 'warning',
        message: `${src.name} (${src.dataType}) → ${proposal.targetField.name} (${proposal.targetField.dataType}): timezone info will be silently dropped`,
        detail: `Source carries timezone offsets. Target stores bare datetime. Values in non-UTC zones will lose their offset, making the stored time ambiguous.`,
        sourceFields: [src.name],
        targetField: proposal.targetField.name,
        suggestion: `Add AT TIME ZONE 'UTC' to normalize to UTC before storing in the naive target column`,
      })
    }
  }
  return issues
}

// ─── FK value gap ───────────────────────────────────────────────────

function checkFkValueGap(proposal: MappingProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const lookupValues = proposal.targetField.fkLookupValues
  if (!proposal.targetField.isForeignKey || !lookupValues || lookupValues.length === 0) return issues

  for (const src of proposal.sourceFields) {
    if (!src.sampleValues || src.sampleValues.length === 0) continue

    const missing = src.sampleValues.filter(v => !lookupValues.includes(v))
    if (missing.length === 0) continue

    const missingPct = Math.round((missing.length / src.sampleValues.length) * 100)

    issues.push({
      check: 'fk_value_gap',
      severity: missingPct > 50 ? 'error' : 'warning',
      message: `${src.name} has values not found in ${proposal.targetField.fkReference ?? 'lookup table'}: ${missingPct}% of sample unmatched`,
      detail: `Missing from lookup: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''}. These rows will fail FK constraints at load time.`,
      sourceFields: [src.name],
      targetField: proposal.targetField.name,
      suggestion: missing.length <= 5
        ? `Insert missing values into ${proposal.targetField.fkReference ?? 'the lookup table'} before migration, or add a CASE WHEN to remap them`
        : `Source values diverge significantly from lookup table. Verify the mapping is correct — this may be the wrong FK target`,
    })
  }
  return issues
}

// ─── Main validator ─────────────────────────────────────────────────

/**
 * Run all deterministic checks on a proposed mapping.
 *
 * This is the core function the agent loop calls after proposing a
 * mapping. If the result has errors, the agent sees the issues and
 * iterates. If only warnings, the mapping passes to the human with
 * warnings displayed.
 *
 * No LLM calls. No network. No side effects. Pure logic.
 */
export function validateMapping(proposal: MappingProposal): ValidationResult {
  const issues: ValidationIssue[] = [
    ...checkTypeCompatibility(proposal),
    ...checkWidthTruncation(proposal),
    ...checkNullViolation(proposal),
    ...checkUniqueViolation(proposal),
    ...checkEnumMismatch(proposal),
    ...checkTimezoneCoercion(proposal),
    ...checkFkValueGap(proposal),
  ]

  const counts = {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
  }

  return {
    valid: counts.errors === 0,
    issues,
    counts,
  }
}

/**
 * Run all deterministic checks on a batch of proposed mappings.
 * Returns per-mapping results keyed by target field name.
 */
export function validateMappingBatch(
  proposals: MappingProposal[],
): Map<string, ValidationResult> {
  const results = new Map<string, ValidationResult>()
  for (const p of proposals) {
    results.set(p.targetField.name, validateMapping(p))
  }
  return results
}
