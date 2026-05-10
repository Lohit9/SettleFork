-- ============================================================
-- Migration 098: Collapse target_acknowledged into coverage canonical
-- ============================================================
--
-- INF-57. Background
-- ------------------
-- Pre-INF-57, "the user is fine with no source for this target field"
-- had two redundant representations:
--
--   * Legacy mapping page write path:
--       target_field_mappings row with is_acknowledged=true,
--       combination_type=NULL, zero mapping_sources rows.
--
--   * Redesign mapping page write path (post-PR α₀):
--       target_field_coverage row with status='approved' AND
--       status_set_by='user' (drawer-side approve via
--       setCoverageStatus in lib/actions/mappings-for-redesign.ts).
--
-- Both render visually identical in the redesigned UI (same row shape,
-- same status, same provenance). The dual representation invites drift:
-- stat formulas had to UNION both surfaces, the translator had a
-- dedicated kind='target_acknowledged' branch, and re-running Path D
-- needed dual-aware lock semantics.
--
-- INF-57 collapses to coverage.status as the canonical surface. The
-- redesign UI exclusively writes coverage rows going forward; this
-- migration backfills existing legacy bare-ack TFMs into matching
-- coverage rows so dual-recognition in the read translator and stat
-- formulas can converge without touching production data.
--
-- The legacy mapping page (deprecation pending separately) continues to
-- write is_acknowledged=true TFMs. Bare-ack TFMs are NOT deleted here —
-- removal happens in a future cleanup migration once the legacy page is
-- gone.
--
-- Empirical baseline (production probe 2026-05-10)
-- ------------------------------------------------
--   • 79 is_acknowledged=true TFMs across 9 distinct projects.
--   • All 79 satisfy the bare-ack invariant: combination_type=NULL,
--     status='approved', zero mapping_sources rows.
--   • 0 target_field_coverage rows exist on those 9 projects (none have
--     run Path D yet).
--   • acknowledgment_reason has 2 distinct sentinel values only:
--     'acknowledged' (41x — legacy page default) and
--     'approved_via_approve_all' (38x — bulk-approve sentinel from
--     lib/actions/mappings.ts:2200). No free-text user rationales.
--
-- Predicted post-migration state
-- ------------------------------
-- 79 NEW coverage rows inserted with coverage_status='gap',
-- status='approved', status_set_by='user'. Zero existing coverage rows
-- updated (none exist for the 79 target_field_ids in question). 79
-- bare-ack TFMs untouched.
--
-- Activity log backfill skipped per INF-57 sign-off: all existing
-- acknowledgment_reason values are sentinels, so backfilling them into
-- activity_log carries no audit value. The reason strings remain on the
-- TFM rows and will be lost only if/when the eventual cleanup migration
-- deletes the bare-ack TFMs — at that point the audit trail of WHO
-- acknowledged when is preserved by git history of the legacy page's
-- mapping_approved emissions.
--
-- Synthesized coverage_status='gap'
-- ---------------------------------
-- Path D never produced a verdict for these target fields. 'gap' is the
-- most semantically faithful default (the AI would say "no source maps
-- to this target — gap"), and matches setCoverageStatus's no-row INSERT
-- path at lib/actions/mappings-for-redesign.ts:229. The user's bare-ack
-- decision says "I'm fine with that gap" — coverage_status='gap' +
-- coverage.status='approved' captures that intent precisely.
--
-- Idempotency
-- -----------
-- ON CONFLICT (project_id, target_field_id) DO UPDATE preserves any
-- existing user-decided coverage row. The DO UPDATE WHERE clause filters
-- out rows where status_set_by='user' so a customer who has subsequently
-- rejected via the drawer is NOT clobbered by re-running this migration.
--
-- INF-53 lock interaction (path-d-persistence.ts:fetchCoverageUserLocks):
-- The next Path D run will see status_set_by='user' on these new rows
-- and preserve their status — correct.

INSERT INTO public.target_field_coverage
  (project_id, target_field_id, coverage_status, status, status_set_by)
SELECT
  tfm.project_id,
  tfm.target_field_id,
  'gap',
  'approved',
  'user'
FROM public.target_field_mappings tfm
WHERE tfm.is_acknowledged = TRUE
ON CONFLICT (project_id, target_field_id) DO UPDATE
  SET status = 'approved',
      status_set_by = 'user',
      updated_at = now()
  WHERE target_field_coverage.status_set_by <> 'user';
