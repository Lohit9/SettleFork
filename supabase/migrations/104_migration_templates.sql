-- Migration 104 — migration template storage (flywheel persistence)
-- ============================================================================
-- Stores reusable mapping templates keyed by source_system + target_system.
-- Each completed migration feeds its approved mappings into a template.
-- Next time someone migrates the same system pair, pre-populate mappings
-- from the template instead of starting from scratch.
--
-- Two tables:
--   migration_templates  — one row per system pair per org
--   template_entries     — one row per field mapping in a template
--
-- RLS: org-scoped. Templates are shared across projects within an org
-- (different clients migrating the same system pair benefit from each other).
-- Cross-org templates are a future consideration (marketplace model) and
-- deliberately excluded here.

-- ─── migration_templates ───────────────────────────────────────────────

CREATE TABLE public.migration_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_system   TEXT NOT NULL,
  target_system   TEXT NOT NULL,
  migration_count INT  NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One template per system pair per org
  UNIQUE (org_id, source_system, target_system)
);

COMMENT ON TABLE public.migration_templates IS
  'Reusable mapping templates keyed by source/target system pair. '
  'Fed by completed migrations, applied to new ones. The flywheel.';

ALTER TABLE public.migration_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_can_view_templates" ON public.migration_templates
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
  );

CREATE POLICY "org_members_can_insert_templates" ON public.migration_templates
  FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
  );

CREATE POLICY "org_members_can_update_templates" ON public.migration_templates
  FOR UPDATE USING (
    org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
  );

-- No DELETE policy — templates are append-only institutional memory.
-- Admin-only purge if ever needed.

-- ─── template_entries ──────────────────────────────────────────────────

CREATE TABLE public.template_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID NOT NULL REFERENCES public.migration_templates(id) ON DELETE CASCADE,

  -- Field signatures stored as JSONB for flexible matching.
  -- Shape: { tableName, fieldName, dataType, isNullable, isForeignKey }
  source_sig      JSONB NOT NULL,
  target_sig      JSONB NOT NULL,

  transform_sql   TEXT,
  explanation     TEXT NOT NULL DEFAULT '',
  confidence      INT  NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),

  -- The flywheel counters
  reuse_count     INT  NOT NULL DEFAULT 0,
  override_count  INT  NOT NULL DEFAULT 0,

  -- Stable key for dedup: "table.field|type|nullable|fk" extracted from target_sig
  target_sig_key  TEXT GENERATED ALWAYS AS (
    (target_sig->>'tableName') || '.' || (target_sig->>'fieldName') || '|' ||
    (target_sig->>'dataType') || '|' || (target_sig->>'isNullable') || '|' ||
    (target_sig->>'isForeignKey')
  ) STORED,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One entry per target field signature per template
  UNIQUE (template_id, target_sig_key)
);

COMMENT ON TABLE public.template_entries IS
  'Individual field mapping entries within a migration template. '
  'reuse_count tracks how many migrations reused this mapping as-is. '
  'override_count tracks how many humans overrode it. '
  'When override_count > reuse_count, the entry self-corrects.';

COMMENT ON COLUMN public.template_entries.source_sig IS
  'Source field signature: { tableName, fieldName, dataType, isNullable, isForeignKey }. Lowercased/normalized.';

COMMENT ON COLUMN public.template_entries.target_sig IS
  'Target field signature: { tableName, fieldName, dataType, isNullable, isForeignKey }. Lowercased/normalized.';

ALTER TABLE public.template_entries ENABLE ROW LEVEL SECURITY;

-- RLS walks up to the parent template's org_id
CREATE POLICY "org_members_can_view_entries" ON public.template_entries
  FOR SELECT USING (
    template_id IN (
      SELECT mt.id FROM public.migration_templates mt
      WHERE mt.org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "org_members_can_insert_entries" ON public.template_entries
  FOR INSERT WITH CHECK (
    template_id IN (
      SELECT mt.id FROM public.migration_templates mt
      WHERE mt.org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "org_members_can_update_entries" ON public.template_entries
  FOR UPDATE USING (
    template_id IN (
      SELECT mt.id FROM public.migration_templates mt
      WHERE mt.org_id IN (SELECT org_id FROM public.org_memberships WHERE user_id = auth.uid())
    )
  );

-- ─── Indexes ───────────────────────────────────────────────────────────

-- Fast lookup: "do we have a template for this system pair?"
CREATE INDEX idx_templates_system_pair
  ON public.migration_templates (org_id, source_system, target_system);

-- Fast join from entries back to templates
CREATE INDEX idx_template_entries_template_id
  ON public.template_entries (template_id);

-- ─── Load order (stored on the template itself) ────────────────────────

ALTER TABLE public.migration_templates
  ADD COLUMN load_order JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.migration_templates.load_order IS
  'Topological load order derived from FK graph across all contributing migrations. '
  'Shape: [{ tableName, sequence, dependsOn[] }]. Kept if longer on merge.';
