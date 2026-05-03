/**
 * Canonical pattern_type vocabulary for emit_extracted_patterns.
 *
 * Settle's migration intelligence system stores patterns extracted from
 * completed projects so future projects can retrieve them as reference
 * context. Without canonical pattern_type strings, projects fragment
 * the vocabulary ("currency_cleanup" vs "currency_strip_format" vs
 * "money_normalization"), breaking retrieval.
 *
 * The seed list below is the v1 canonical vocabulary, drafted from
 * (a) Settle's existing transformation engine, (b) the migration
 * intelligence system prompt's per-category templates, and (c) common
 * enterprise data migration patterns. Phase 3 will refine this list
 * based on actual customer-project pattern emergence in
 * `ai_edit_history`.
 *
 * The AI is told (via EMIT_EXTRACTED_PATTERNS_TOOL.pattern_config
 * description) to PREFER these canonical strings when patterns fit,
 * and to coin new pattern_type values only for genuinely novel patterns
 * that don't fit any canonical bucket.
 */

export const TRANSFORMATION_RECIPE_PATTERNS = {
  currency_cleanup:
    'Strip currency formatting (currency symbols, commas, parentheses for negatives) before numeric cast',
  date_format_normalization:
    'Convert mixed date formats (MM/DD/YYYY, DD-MMM-YY, ISO 8601, etc.) to a target-canonical format',
  phone_format_normalization:
    'Standardize phone number formats across regional conventions (+1, parentheses, dashes, extensions)',
  boolean_value_normalization:
    'Normalize Y/N, yes/no, 1/0, T/F, TRUE/FALSE variants to a canonical boolean',
  casing_standardization:
    'Normalize casing for proper-name fields (Title Case for names, UPPER for codes, lower for emails)',
  whitespace_trimming:
    'Strip leading and trailing whitespace; collapse multiple internal spaces',
  enum_value_translation:
    'Map source enum values to target allowed-set (e.g., "Won" → "Closed Won")',
  varchar_truncation_handling:
    'Handle source values exceeding target VARCHAR length (truncate, escalate to review, or split)',
  fk_reformat_cascade:
    'Propagate PK format changes (e.g., int → uuid, prefix added) through dependent FK columns',
  name_parsing:
    'Split full-name fields into first/middle/last components',
  address_parsing:
    'Split address strings into structured components (street/city/state/zip)',
  null_default_substitution:
    'Fill missing required values with target-appropriate defaults',
} as const

export const DATA_QUALITY_PATTERNS = {
  null_violation: 'Null values on target NOT NULL fields',
  fk_orphan: 'FK references to non-existent parent rows',
  duplicate_pk: 'Duplicate primary keys violating uniqueness constraint',
  type_conversion_failure:
    'Source values that fail target type cast (e.g., non-numeric strings in NUMERIC, invalid dates)',
  length_truncation_risk: 'Source values exceeding target column length',
  format_inconsistency:
    'Same field with mixed value formats (e.g., dates as both MM/DD/YYYY and YYYY-MM-DD)',
  cross_field_inconsistency:
    'Fields whose values violate documented relationships (e.g., close_date before created_date)',
  suspicious_distribution:
    'Value distributions suggesting data quality issues (e.g., 95% NULL on a "required" field)',
} as const

export const DOMAIN_KNOWLEDGE_PATTERNS = {
  entity_relationship_model:
    'Non-obvious entity relationships in source system (e.g., legal ELM systems link timekeepers via matters)',
  load_order_dependency:
    'Table load order constraints due to FK dependencies (parent tables before children)',
  business_rule_constraint:
    'Business rules implied by source data patterns (e.g., "all closed deals have a close_reason")',
  required_field_set:
    'Target fields that must be populated before loading, beyond schema NOT NULL',
} as const

export const SOURCE_SYSTEM_HINT_PATTERNS = {
  legacy_format_quirk:
    'Systematic format quirks in legacy source systems (Y2K-style dates, packed decimals, EBCDIC remnants)',
  mainframe_encoding:
    'EBCDIC, COBOL fixed-length record layouts, mainframe-era encoding conventions',
  proprietary_field_pattern:
    'Vendor-specific field naming or structure conventions (NetSuite custom fields, Salesforce __c suffix)',
  soft_delete_convention:
    'System-level soft-delete patterns (deleted_at IS NOT NULL, is_active = false, status = "archived")',
} as const

export const ALL_CANONICAL_PATTERNS = {
  ...TRANSFORMATION_RECIPE_PATTERNS,
  ...DATA_QUALITY_PATTERNS,
  ...DOMAIN_KNOWLEDGE_PATTERNS,
  ...SOURCE_SYSTEM_HINT_PATTERNS,
} as const

export type CanonicalPatternType = keyof typeof ALL_CANONICAL_PATTERNS
