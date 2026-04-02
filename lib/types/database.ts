export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  status: 'active' | 'completed' | 'archived'
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
}

export interface Dataset {
  id: string
  project_id: string
  role: 'source' | 'target'
  name: string
  created_at: string
}

export interface DBTable {
  id: string
  dataset_id: string
  name: string
  row_count: number
  csv_storage_path: string | null
  created_at: string
}

export type CheckConstraint =
  | { type: 'in_list'; allowedValues: string[]; raw: string }
  | { type: 'regex'; pattern: string; raw: string }
  | { type: 'range'; min?: number; max?: number; raw: string }
  | { type: 'custom'; raw: string }

export interface Field {
  id: string
  table_id: string
  name: string
  data_type: string
  inferred_type: string | null
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  ordinal_position: number
  created_at: string
  check_constraint: CheckConstraint | null
}

export interface DataRow {
  id: number
  table_id: string
  row_number: number
  row_data: Record<string, unknown>
}

export interface FieldProfile {
  id: string
  field_id: string
  total_rows: number
  null_count: number
  null_percentage: number
  cardinality: number
  unique_percentage: number
  format_issues_count: number
  min_value: string | null
  max_value: string | null
  sample_values: unknown[] | null
  value_distribution: { value: string; count: number }[] | null
  computed_at: string
}

export interface SchemaDocument {
  id: string
  dataset_id: string | null
  project_id: string | null
  doc_type: 'schema' | 'business_context'
  filename: string
  file_size: number | null
  file_storage_path: string
  extracted_text: string | null
  created_at: string
}

export interface TableMapping {
  id: string
  project_id: string
  source_table_id: string
  target_table_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  created_at: string
}

export interface FieldMapping {
  id: string
  table_mapping_id: string
  source_field_id: string | null
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  similar_fields_considered: unknown[] | null
  type_compatibility: string | null
  /** AI assessment from mapping generation; null if not assessed (manual / partial AI flows) */
  needs_transformation: boolean | null
  /** True when this is a secondary source contributing to a target that already has a primary mapping */
  is_contributing: boolean
  created_at: string
}

export interface FixOption {
  label: string
  description: string
  sql: string
  tradeoff: string
  downstream_impact: string
  risk_level: 'low' | 'medium' | 'high'
  estimated_rows_affected: number
}

export interface QualityIssue {
  id: string
  project_id: string
  field_id: string | null
  table_id: string | null
  stage: 'source' | 'in_flight' | 'target'
  severity: 'blocking' | 'warning'
  title: string
  description: string
  affected_records: number
  ai_suggested_fix: string | null
  ai_fix_options: FixOption[] | null
  downstream_impact: string | null
  affected_rows_sample: Record<string, unknown>[] | null
  generated_sql: string | null
  status: 'open' | 'fixed' | 'accepted_risk'
  detection_source: 'auto' | 'manual_scan' | 'custom_rule'
  /** Added by migration 022 — distinguishes auto/custom_rule/ai_augmented/manual */
  detection_type?: 'auto' | 'custom_rule' | 'ai_augmented' | 'manual'
  /** Added by migration 024 — machine-readable issue category used by flag_staged_rows_for_issue */
  issue_kind?: string | null
  validation_rule_id: string | null
  created_at: string
}

export interface ValidationRule {
  id: string
  project_id: string
  field_id: string | null
  table_id: string | null
  name: string
  description: string | null
  rule_type: string
  rule_config: Record<string, unknown>
  severity: 'blocking' | 'warning'
  is_ai_generated: boolean
  ai_original_prompt: string | null
  created_at: string
}

export interface FixHistory {
  id: string
  quality_issue_id: string | null
  project_id: string
  table_id: string
  fix_description: string
  fix_sql: string
  fix_option_chosen: string | null
  affected_row_count: number
  old_values_sample: Record<string, unknown>[] | null
  status: 'applied' | 'reverted'
  snapshot_failed: boolean | null
  applied_by: string
  applied_at: string
  reverted_at: string | null
}

export interface FixSnapshot {
  id: string
  fix_history_id: string
  row_id: number
  row_number: number | null
  old_row_data: Record<string, unknown>
}

export interface ReadinessScore {
  score: number
  status: 'ready' | 'at_risk' | 'not_ready'
  blocking_count: number
  warning_count: number
  ready_field_count: number
  total_fields_checked: number
  unmapped_required_count: number
  top_issues: QualityIssue[]
}

export interface Transformation {
  id: string
  field_mapping_id: string
  description: string | null
  generated_sql: string
  is_ai_generated: boolean
  test_results: unknown | null
  status: 'draft' | 'tested' | 'saved' | 'applied' | 'stale'
  created_at: string
}

export interface Output {
  id: string
  project_id: string
  type:
    | 'mapping_file'
    | 'transformation_specs'
    | 'readiness_report'
    | 'gold_standard_csv'
    | 'gold_standard_sql'
    | 'fix_log'
    | 'data_dictionary'
  format: string
  version: string
  file_storage_path: string | null
  generated_at: string
}

export interface StagedDataRow {
  id: number
  table_mapping_id: string
  source_table_id: string
  target_table_id: string
  row_number: number
  source_row_data: Record<string, unknown>
  transformed_row_data: Record<string, unknown>
  staged_at: string
}

export type ProjectWithDatasets = Project & { datasets: Dataset[] }

export interface ProjectWithStats {
  id: string
  name: string
  source_label: string
  target_label: string
  status: 'active' | 'completed' | 'archived'
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
  totalSourceFields: number
  mappedFieldCount: number
  totalRows: number
  blockingIssueCount: number
  warningCount: number
  totalTransforms: number
  savedTransforms: number
  needsTransformCount: number
  coveredTransformCount: number
  readinessScore: number | null
  currentPhase: number
  outputCount: number
}

export interface MigrationIntelligence {
  id: string
  user_id: string
  category: 'transformation_recipe' | 'data_quality_pattern' | 'domain_knowledge' | 'source_system_hint'
  title: string
  pattern_description: string
  pattern_config: Record<string, unknown>
  confidence: number
  times_seen: number
  times_confirmed: number
  times_rejected: number
  tags: string[]
  source_project_ids: string[]
  created_at: string
  updated_at: string
}

// ── SQL Dialect ───────────────────────────────────────────────────────────────

export type SqlDialect = 'postgresql' | 'tsql' | 'mysql'

export interface SqlDialectInfo {
  id: SqlDialect
  label: string
  description: string
}

export const SQL_DIALECTS: SqlDialectInfo[] = [
  { id: 'postgresql', label: 'PostgreSQL', description: 'PostgreSQL, Amazon RDS, Aurora PostgreSQL, Supabase' },
  { id: 'tsql', label: 'T-SQL (MS SQL Server)', description: 'Microsoft SQL Server, Azure SQL Database' },
  { id: 'mysql', label: 'MySQL', description: 'MySQL, Amazon Aurora MySQL, MariaDB' },
]

// ── DB Connection ──────────────────────────────────────────────────────────────

export interface DBConnection {
  id: string
  project_id: string
  dataset_id: string
  db_type: 'postgresql' | 'mysql' | 'mssql'
  host: string
  port: number
  database_name: string
  username: string
  password_encrypted: string
  ssl_mode: 'disable' | 'require' | 'verify-ca' | 'verify-full'
  status: 'connected' | 'failed' | 'disconnected'
  last_connected_at: string | null
  created_at: string
  updated_at: string
}

// Safe version for client — password_encrypted is excluded
export interface DBConnectionInfo {
  id: string
  db_type: 'postgresql' | 'mysql' | 'mssql'
  host: string
  port: number
  database_name: string
  username: string
  ssl_mode: string
  status: string
  last_connected_at: string | null
}
