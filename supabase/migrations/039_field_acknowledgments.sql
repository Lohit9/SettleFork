-- Field acknowledgments: tracks explicit user decisions on unmapped fields
-- Every source and target field should be either mapped or acknowledged

CREATE TABLE field_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('source', 'target')),
  reason TEXT NOT NULL,
  notes TEXT,
  acknowledged_by UUID REFERENCES auth.users(id),
  acknowledged_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, field_id)
);

ALTER TABLE field_acknowledgments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own project acknowledgments"
  ON field_acknowledgments FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE INDEX idx_field_ack_project ON field_acknowledgments(project_id);
CREATE INDEX idx_field_ack_field ON field_acknowledgments(field_id);
