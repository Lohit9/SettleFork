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
  generated_sql: string | null
  status: 'open' | 'fixed' | 'accepted_risk'
  created_at: string
}

export interface Transformation {
  id: string
  field_mapping_id: string
  description: string | null
  generated_sql: string
  is_ai_generated: boolean
  test_results: unknown | null
  status: 'draft' | 'tested' | 'saved'
  created_at: string
}

export interface Output {
  id: string
  project_id: string
  type: 'mapping_file' | 'transformation_specs' | 'readiness_report'
  format: string
  version: string
  file_storage_path: string | null
  generated_at: string
}

export type ProjectWithDatasets = Project & { datasets: Dataset[] }
