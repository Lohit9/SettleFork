-- ============================================================
-- Migration 096: target_field_coverage AI confidence column
-- ============================================================
--
-- Background
-- ----------
-- PR γ.1 — AI confidence on no-source rows. The redesigned mapping
-- grid surfaces a confidence percentage on every row via
-- ConfidenceCell (FieldMappingRow.tsx:1267-1303). Mapped + VA rows
-- already render TFM.confidence; target_acknowledged rows render an
-- em-dash; unmapped rows currently render an em-dash because no
-- confidence signal exists for "no-source" coverage decisions.
--
-- This migration adds a confidence column to target_field_coverage
-- so Path D can emit a calibrated 0.0-1.0 score alongside each
-- coverage_status verdict (gap / optional / out_of_scope / partial /
-- covered). The translator (lib/ai/mapping-engine.ts) flows this
-- value onto UnmappedRow.confidence when no TFM exists, giving the
-- ConfidenceCell a meaningful number to render on the no-source rows
-- where it currently shows em-dash only.
--
-- Type / nullability
-- ------------------
-- NUMERIC(5,2) matches the precision of `target_field_mappings.confidence`
-- (migration 074:155). The CHECK constraint permits BOTH the 0.0-1.0
-- LLM scale and the 0-100 legacy scale, mirroring the existing scale-
-- tolerance of `target_field_mappings.confidence` (the column carries
-- mixed scales in production: Path D persistence writes 0.0-1.0 per
-- lib/ai/path-d-persistence.ts:380 `confidence: m.confidence ?? null`,
-- while the legacy mapping-generation path in lib/actions/mappings.ts
-- writes 0-100). The UI's `formatConfidencePercent` and
-- `classifyRowConfidence` (lib/utils/confidence-format.ts) normalize via
-- `confidence > 1 ? confidence : confidence * 100`, so either scale
-- renders correctly.
--
-- PR γ.1 forward-only writes use the 0.0-1.0 scale (CoveragePayload's
-- LLM-emitted value, persisted directly without multiplication —
-- mirrors the Path D TFM persistence convention).
--
-- NULL-able, NO BACKFILL — pre-PR-γ.1 coverage rows on existing
-- projects (e.g., Rootstock POC TEST e441baa5, ~163 rows; production
-- demos) carry NULL confidence and the UI renders the em-dash branch
-- of ConfidenceCell as today. Forward-only: future Path D runs populate
-- the column on insert/upsert. No re-run of Path D is required to
-- adopt the new signal.
--
-- Calibration evidence (Stop 1 PAUSE-B, 2026-05-09)
-- --------------------------------------------------
-- Five trial spot-check (4 eval fixtures + Rootstock POC dev project)
-- confirmed the prompt mechanic emits calibrated confidence:
--   * Distribution variable (σ=0.085 on real-shape n=163; full 5-tier
--     coverage including 8 rows in 0.50-0.70 band)
--   * Per-status decomposition is intuitive:
--       partial      mean 0.631  (semantic-granularity uncertainty)
--       gap          mean 0.802
--       covered      mean 0.868
--       optional     mean 0.870
--       out_of_scope mean 0.907  (clearly excluded by business context)
--   * Pooled fixture lift +0.028 (weak); ERP fixture (cleanest gold)
--     +0.102 confirms real correlation. MKT +0.001 reflects fixture
--     ambiguity, not model noise.
-- Decision rule "variable + reasonably calibrated → ship" met.
--
-- RLS: existing target_field_coverage policies (project-membership read,
-- editor write — see migration 093:91-105) carry over unchanged.

ALTER TABLE public.target_field_coverage
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,2)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100));

COMMENT ON COLUMN public.target_field_coverage.confidence IS
  'AI-emitted confidence on the coverage_status verdict. PR γ.1 writes '
  'use the 0.0-1.0 LLM scale (mirrors Path D TFM persistence at '
  'path-d-persistence.ts:380); CHECK permits 0-100 too for scale '
  'tolerance against the convention used elsewhere. NULL on pre-PR-γ.1 '
  'rows. The redesigned mapping grid surfaces this on no-source rows '
  '(UnmappedRow.confidence) via ConfidenceCell with no special-casing.';
