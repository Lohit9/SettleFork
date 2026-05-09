-- ============================================================
-- Migration 095: target_field_coverage status + status_set_by
-- ============================================================
--
-- Background
-- ----------
-- PR γ — Mapping grid state model unification. The redesigned Mapping
-- grid renders one uniform row per target field with a derived status,
-- regardless of whether the row is backed by a TFM, a value-assignment,
-- a coverage row alone, or nothing (orphan / target_only). To support
-- this, every coverage row needs its OWN approval lifecycle, separate
-- from the TFM's status.
--
-- This migration adds two columns to public.target_field_coverage:
--
--   status           — needs_review | approved | rejected
--                      The coverage row's own approval state. Independent
--                      of any associated TFM's status (a single target
--                      field can have a coverage row without a TFM, or
--                      both — the TFM's status drives the row prop's
--                      effective status when present, with coverage.status
--                      as fallback per the resolution priority documented
--                      in lib/ai/mapping-engine.ts).
--
--   status_set_by    — ai_auto | user | system_default
--                      Provenance of the current `status` value. Forward-
--                      written rows from path-d-persistence.ts use
--                      'ai_auto' (Path D authored the status alongside
--                      the coverage_status verdict). User overrides
--                      (drawer-side approve/reject) flip to 'user'.
--                      'system_default' is reserved for the synthesized
--                      target_only case (no coverage row exists; the
--                      read translator emits a default needs_review +
--                      system_default row prop).
--
-- Default status mapping per coverage_status (Path-D-authored rows):
--   out_of_scope | optional         → status='approved'
--   gap | covered | partial         → status='needs_review'
--
-- ┌──────────────────────────────────────────────────────────────────┐
-- │ [PR γ.2 REVERSAL, 2026-05-09]                                    │
-- │                                                                  │
-- │ The categorical-kind-based auto-approve mapping above (out_of_   │
-- │ scope/optional → approved) was REVERSED in migration 097 +       │
-- │ lib/ai/path-d-persistence.ts:defaultStatusForCoverageStatus.     │
-- │ Per founder principle "AI proposes → deterministic validates →   │
-- │ human approves", status='approved' + status_set_by='ai_auto' is  │
-- │ no longer producible by the persistence layer. Forward Path-D-   │
-- │ authored rows are now uniformly status='needs_review' regardless │
-- │ of coverage_status. Migration 097 backfills existing auto-       │
-- │ approved rows. The categorical-kind defaults documented above    │
-- │ are NO LONGER USED for forward writes — the backfill SQL further │
-- │ down this file (the WHERE status_set_by='system_default' UPDATE) │
-- │ remains historical record of the initial column population.      │
-- └──────────────────────────────────────────────────────────────────┘
--
-- Rationale for covered/partial defaulting to needs_review (not
-- mirroring TFM.status):
--   The coverage row's status is metadata, not the row's effective
--   approval state. When a TFM exists, the row prop's `status` field
--   resolves to TFM.status — coverage.status is irrelevant for that
--   case. Defaulting to needs_review preserves the option for future
--   "AI auto-approves high-confidence covered rows" without requiring
--   a backfill at that point.
--
-- Backfill semantics:
--   The WHERE status_set_by = 'system_default' clause makes the
--   backfill idempotent — currently affects all rows (column is brand
--   new, default = 'system_default' applies to every existing row).
--   Re-running is safe (would only re-touch rows still at the default).
--
-- Forward-only writes (post-merge): path-d-persistence.ts:persistCoverage
-- sets status + status_set_by directly during INSERT/UPSERT, so future
-- AI-emitted rows never pass through 'system_default'.
--
-- RLS: existing target_field_coverage policies (project-membership read,
-- editor write — see migration 093:91-105) carry over unchanged. The
-- new columns are not separately gated.

ALTER TABLE public.target_field_coverage
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS status_set_by TEXT NOT NULL DEFAULT 'system_default'
    CHECK (status_set_by IN ('ai_auto', 'user', 'system_default'));

COMMENT ON COLUMN public.target_field_coverage.status IS
  'Coverage row approval lifecycle: needs_review | approved | rejected. '
  'Independent of any associated TFM status. The read translator '
  '(lib/ai/mapping-engine.ts) prefers TFM.status when a TFM exists; '
  'coverage.status is the fallback when no TFM points at this target.';

COMMENT ON COLUMN public.target_field_coverage.status_set_by IS
  'Provenance of the current status value: ai_auto (Path D wrote it), '
  'user (drawer-side approve/reject override), system_default '
  '(synthesized for target_only orphan cases at read time — never '
  'persisted with this value).';

-- Backfill: derive status from coverage_status per the categorical-kind
-- defaults. Idempotent via the WHERE clause; safe to re-run.
UPDATE public.target_field_coverage
SET
  status = CASE
    WHEN coverage_status IN ('out_of_scope', 'optional') THEN 'approved'
    WHEN coverage_status IN ('gap')                      THEN 'needs_review'
    WHEN coverage_status IN ('covered', 'partial')       THEN 'needs_review'
    ELSE 'needs_review'
  END,
  status_set_by = 'ai_auto'
WHERE status_set_by = 'system_default';

-- Index on (project_id, status) for the read translator's grid query
-- (filter by project + status across thousands of target fields).
CREATE INDEX IF NOT EXISTS idx_target_field_coverage_project_row_status
  ON public.target_field_coverage (project_id, status);
