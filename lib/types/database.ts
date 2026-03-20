export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  status: 'active' | 'completed' | 'archived'
  created_at: string
  updated_at: string
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
  computed_at: string
}

export interface SchemaDocument {
  id: string
  dataset_id: string
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
  source_field_id: string
  target_field_id: string
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected'
  ai_reasoning: string | null
  similar_fields_considered: unknown[] | null
  type_compatibility: string | null
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
  totalSourceFields: number
  mappedFieldCount: number
  totalRows: number
  blockingIssueCount: number
  warningCount: number
  totalTransforms: number
  savedTransforms: number
  readinessScore: number | null
  currentPhase: number
  outputCount: number
}
