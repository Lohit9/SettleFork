-- Migration 103 — source-side rejection persistence (flat / spreadsheet view)
-- ============================================================================
-- Adds a `decision` column to `source_field_acknowledgments` so the flat
-- Mapping view can persist the user-rejected state for an unmapped source
-- row. Existing rows backfill to 'acknowledged' via the DEFAULT clause.
--
-- WHY a column on the existing table instead of a sibling table:
--   - UNIQUE (project_id, source_field_id) already enforces "one decision
--     per source field". Adding a sibling table would risk drift if a row
--     accidentally landed in both.
--   - Source-side "acknowledged" and "rejected" are categorically the same
--     downstream concept: this source field is not contributing to a
--     mapping. The user-facing label differs; the persistence shape does
--     not. Existing consumers (recomputeTableMappingStatus, project-stats,
--     readiness-score) continue to treat ANY row in this table as "source
--     is decided" — unchanged behaviour.
--   - The read translator (lib/ai/mapping-engine.ts) widens to surface
--     decision='rejected' rows as a distinct UI state without a schema
--     migration on the rest of the read path.
--
-- ROLLBACK CAVEAT (see lib/actions/spreadsheet-view-server-investigation
-- §4.3): the `reason` NOT NULL drop is sticky. Rollback requires
-- backfilling rejected rows with non-empty reasons first, otherwise
-- `SET NOT NULL` will fail. Run:
--     UPDATE public.source_field_acknowledgments
--        SET reason = 'Rejected via flat view'
--      WHERE reason = '' OR reason IS NULL;
-- before dropping the column.

ALTER TABLE public.source_field_acknowledgments
  ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'acknowledged'
    CHECK (decision IN ('acknowledged', 'rejected'));

-- The existing `reason TEXT NOT NULL` constraint suits 'acknowledged'
-- (the modal collects a reason). Flat-view rejection is one-click with
-- no reason prompt — relax NOT NULL and default to '' so rejection
-- writes can omit it.
ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE public.source_field_acknowledgments
  ALTER COLUMN reason SET DEFAULT '';

COMMENT ON COLUMN public.source_field_acknowledgments.decision IS
  'User decision on this source field. ''acknowledged'' (default) means '
  'the user accepts the field will not be migrated (modal path). '
  '''rejected'' is the flat-view "no" verb — semantically equivalent '
  'downstream but tracked separately so the UI can render the explicit '
  'rejection state and the activity log distinguishes the two intents.';

CREATE INDEX IF NOT EXISTS idx_source_field_acknowledgments_decision
  ON public.source_field_acknowledgments (project_id, decision);

-- RLS: the existing project-membership policies (074 STEP 3c) cover the
-- new column transparently. No additional grants required.
