-- ============================================================================
-- Migration 077 — Add va_dismissed + dismissal_reason to target_field_mappings
-- ============================================================================
-- Ships with Phase 3 of the Transform-page redesign (target-led sidebar +
-- VA dismissal symmetry).
--
-- Why
--   Today, value-assignment fields (TFMs whose `combination_type='custom_sql'`
--   and have zero `mapping_sources`) are FORCED to `needsTransform = true`
--   inside `getTransformData` with no dismissal mechanism. They appear
--   forever in the `Define` state until the user defines a value or
--   acknowledges the field on the Mapping page.
--
--   The Transform page redesign introduces a symmetric "no value generation
--   needed" dismissal — analogous to the existing "no transform needed"
--   dismissal (`needs_transformation = false`) for mapped fields, but
--   distinct in semantics:
--
--     - `needs_transformation = false` → "this mapping doesn't need SQL
--       transformation; the source value passes through directly."
--     - `va_dismissed = true`           → "this target field doesn't need
--       a value at all (DB default, auto-generated, or intentional NULL)."
--
--   Conflating the two would risk readiness-score / load-SQL bugs because
--   readers behave differently in each case (mapped + transform-dismissed
--   still emits a SELECT column; VA-dismissed must be omitted from SELECT
--   entirely).
--
-- Forward-compatibility
--   Phase 4 (acknowledgment consolidation, future) is expected to fold
--   `is_acknowledged`, `acknowledgment_reason`, `va_dismissed`, and
--   `dismissal_reason` into a single unified dismissal state machine.
--   Storing `dismissal_reason` from day 1 means that consolidation is a
--   pure column-rename / merge — no schema-add-then-backfill cycle.
--
-- Schema choice rationale (Option A vs. B from investigation)
--   A) Two columns: `va_dismissed BOOLEAN` + `dismissal_reason TEXT NULL`.
--   B) One unified pair: `dismissed BOOLEAN` + `dismissal_kind ENUM`.
--
--   Option A wins because it doesn't require migrating the existing
--   `needs_transformation = false` semantic into a unified column. It is
--   also parallel to the existing `is_acknowledged + acknowledgment_reason`
--   pair on the same table, so readers and writers can mirror that
--   precedent exactly.
--
-- RLS
--   `target_field_mappings` RLS already keys on `project_id` ownership; the
--   additive columns are covered by existing policies. No policy update.
--
-- Verification queries (after successful execution)
--   SELECT COUNT(*) FROM public.target_field_mappings
--     WHERE va_dismissed = TRUE;
--   -- Expected: 0 immediately post-migration; non-zero only after users
--   -- begin dismissing VA fields via the Transform UI.
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'target_field_mappings'
--      AND column_name IN ('va_dismissed', 'dismissal_reason');
-- ============================================================================

ALTER TABLE public.target_field_mappings
  ADD COLUMN IF NOT EXISTS va_dismissed     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dismissal_reason TEXT             DEFAULT NULL;

COMMENT ON COLUMN public.target_field_mappings.va_dismissed IS
  'TRUE when the user has dismissed the value-assignment requirement for '
  'this target field (e.g., the field has a DB default, is auto-generated, '
  'or is intentionally left NULL). Only meaningful for VA TFMs '
  '(combination_type=''custom_sql'' AND zero mapping_sources). Mapped TFMs '
  'use `needs_transformation = false` to dismiss transform requirements; '
  'the two flags are intentionally distinct (different semantics for '
  'load-SQL emission and readiness scoring).';

COMMENT ON COLUMN public.target_field_mappings.dismissal_reason IS
  'Free-text rationale captured at dismissal time, parallel to '
  '`acknowledgment_reason`. NULL when no rationale was supplied. Reserved '
  'for future Phase 4 acknowledgment-consolidation work where '
  '`is_acknowledged`, `va_dismissed`, and their reason columns may be '
  'folded into a unified dismissal state machine.';
