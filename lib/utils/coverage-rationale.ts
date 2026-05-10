// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — coverage rationale formatter for the mapping drawer.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure formatter that derives the drawer's COVERAGE section payload from a
// `target_field_coverage` row (or the absence of one — the synthesized
// target_only orphan case). Pulls together three pieces:
//
//   1. The short categorical label (e.g. "Out of scope") — sourced from
//      `STATUS_LABEL` in `components/path-d/CoverageStatusBadge.tsx` so the
//      badge and the drawer rationale never drift.
//   2. The long-form rationale prose — verbatim from `coverage.ai_reasoning`
//      when present; null otherwise.
//   3. A short suggested user action — UI-owned mapping per coverage_status,
//      hardcoded below. The synthesized orphan case (no coverage row at
//      all on a no-source row) returns "Manual entry required" + a
//      call-to-action.
//
// All exports MUST stay pure functions — no side effects, no React imports,
// no DOM access. Keeps the formatter unit-testable without rendering.

import type { TargetFieldCoverageRow } from '@/lib/types/path-d'

/**
 * Short categorical label per coverage_status enum value (migration 093:58).
 *
 * Mirrored verbatim from `STATUS_LABEL` in
 * `components/path-d/CoverageStatusBadge.tsx`. Duplicating these 5 entries
 * keeps this util pure (no React import) and keeps the badge component
 * self-contained. A future cleanup can promote the constant to a shared
 * module if a third caller appears.
 */
const COVERAGE_STATUS_LABEL = {
  covered: 'Covered',
  partial: 'Partial',
  gap: 'Gap',
  optional: 'Optional',
  out_of_scope: 'Out of scope',
} as const

/**
 * Synthesized label rendered when a no-source row has no coverage row at
 * all (the AI never produced a verdict for this target field). The drawer's
 * COVERAGE section flows the user toward picking a source or acknowledging
 * the field via the body's pencil affordance and the existing footer.
 */
const ORPHAN_LABEL = 'Manual entry required'
const ORPHAN_REASONING = 'No AI verdict yet — provide a source or acknowledge.'

/**
 * Per-status suggested user action. `null` means the row is informational
 * and no follow-up is expected (out_of_scope, optional). The two anomaly
 * cases — `covered` / `partial` arriving on a no-source row — surface a
 * "flagged for investigation" hint rather than a user action; the read
 * translator should not be emitting these on no-source rows in steady
 * state, so the drawer treats them as a contract violation worth flagging.
 */
const SUGGESTED_ACTION_BY_STATUS: Record<
  TargetFieldCoverageRow['coverage_status'],
  string | null
> = {
  covered: 'Mapping pending — flagged for investigation.',
  partial: 'Partial coverage — flagged for investigation.',
  gap: 'Pick a source via the pencil, or acknowledge as not migratable.',
  optional: null,
  out_of_scope: null,
}

export interface CoverageRationale {
  /** Short categorical label rendered as the section's lead line. */
  label: string
  /** Free-form AI rationale prose, or null when not present. */
  reasoning: string | null
  /** Hardcoded UI suggestion for the user, or null when informational. */
  suggestedAction: string | null
}

/**
 * Derive the COVERAGE section payload from a `target_field_coverage` row.
 *
 * `coverage === null` is the synthesized target_only orphan case — only
 * meaningful on no-source rows. Callers on acknowledged rows are
 * expected to skip rendering when the lookup misses (per align-on-approach
 * — the orphan label "Manual entry required" reads oddly on an explicitly
 * closed acknowledged row).
 */
export function getCoverageRationale(
  coverage: TargetFieldCoverageRow | null,
): CoverageRationale {
  if (coverage === null) {
    return {
      label: ORPHAN_LABEL,
      reasoning: ORPHAN_REASONING,
      suggestedAction: null,
    }
  }
  return {
    label: COVERAGE_STATUS_LABEL[coverage.coverage_status],
    reasoning: coverage.ai_reasoning,
    suggestedAction: SUGGESTED_ACTION_BY_STATUS[coverage.coverage_status],
  }
}
