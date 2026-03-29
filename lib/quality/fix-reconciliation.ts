/**
 * Fix-history reconciliation helpers.
 *
 * After a full rescan, the detection engine deletes old quality_issues rows and
 * re-inserts fresh ones with status = 'open'.  Because fix_history has a
 *   quality_issue_id UUID REFERENCES quality_issues(id) ON DELETE SET NULL
 * constraint, every fix_history entry whose original issue was deleted by the
 * rescan ends up with quality_issue_id = NULL.
 *
 * A NULL quality_issue_id on an 'applied' fix therefore means:
 *   "this fix was applied, the project was subsequently rescanned, and the
 *    original issue row is gone — the issue either no longer exists (successful
 *    fix) or was re-created under a new UUID."
 *
 * We surface these as "Verified fixed" items in the Validate tab so users can
 * see what was resolved after a rescan, even though the quality_issues table no
 * longer has a 'fixed' row for them.
 *
 * Pure module — no database calls, no side effects.
 */

import type { FixHistory } from '@/lib/types/database'

export interface VerifiedFix {
  /** fix_history.id */
  id: string
  /** fix_history.table_id — used for table-filter matching */
  tableId: string
  /** fix_history.fix_description */
  fixDescription: string
  /** fix_history.affected_row_count */
  affectedRowCount: number
  /** fix_history.applied_at */
  appliedAt: string
}

/**
 * Returns fix_history entries that represent fixes applied before the most
 * recent rescan (quality_issue_id = NULL) and that have not been reverted.
 *
 * These are the "verified fixed" items: the original quality_issue was deleted
 * by the rescan, so the issue no longer appears in the quality_issues table.
 */
export function getVerifiedFixes(fixHistory: FixHistory[]): VerifiedFix[] {
  return fixHistory
    .filter((f) => f.status === 'applied' && f.quality_issue_id === null)
    .map((f) => ({
      id: f.id,
      tableId: f.table_id,
      fixDescription: f.fix_description,
      affectedRowCount: f.affected_row_count,
      appliedAt: f.applied_at,
    }))
}
