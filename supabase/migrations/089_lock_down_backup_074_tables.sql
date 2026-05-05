-- ============================================================================
-- Migration 089 — RLS lockdown for migration 074 backup tables
-- ============================================================================
-- Backup tables created by migration 074 (mapping redesign data migration)
-- were flagged by the Supabase Advisor as publicly accessible without RLS
-- enabled. This migration enables RLS on both backup tables, locking them
-- to service_role access only (RLS-on with no policies = service_role only).
--
-- Migration 074's own retention clause (lines 30-32 of 074) specifies these
-- backups exist "for 60+ days post-deploy" for audit/recovery. They will be
-- dropped on/after 2026-06-21 in a follow-up migration.
--
-- IMPORTANT: This SQL was applied directly via Supabase SQL Editor on
-- 2026-05-05 (file_mappings_backup_074: 778 rows, field_acknowledgments_backup_074:
-- 60 rows). This file is record-keeping — it documents what was applied,
-- it does NOT need to be re-run. Per CLAUDE.md §8.2, all migrations are
-- gated through manual application.
-- ============================================================================

ALTER TABLE public.field_mappings_backup_074 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_acknowledgments_backup_074 ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.field_mappings_backup_074 IS
  'Mapping-redesign backup from migration 074 (deployed 2026-04-22). RLS-locked 2026-05-05. Drop on/after 2026-06-21 (deploy + 60 days).';
COMMENT ON TABLE public.field_acknowledgments_backup_074 IS
  'Mapping-redesign backup from migration 074 (deployed 2026-04-22). RLS-locked 2026-05-05. Drop on/after 2026-06-21 (deploy + 60 days).';
