import type { MappingSourceRef } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 5b — MappedRow classifier.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure, fixture-friendly classifier for the four mapped-row rendering rules
// defined in the canonical spec (docs/features/mapping-redesign.md §Row design
// lines ~695-784). The classifier only answers the VISUAL-complexity question;
// the row kind dispatcher in FieldMappingRow still gates on `row.kind` first
// (value_assignment / target_acknowledged / unmapped never call this helper).
//
// Rules (strict — only one fires per row):
//
//   Rule 1 — Single source field
//     1 source. Gap 5a visual. No chevron.
//
//   Rule 2 — Multi-source, same table
//     2+ sources AND all `sourceTable.id` identical.
//     Renders one badge + comma-separated field names + chevron.
//
//   Rule 3 — Cross-table, two tables
//     2+ sources AND exactly 2 distinct `sourceTable.id` values.
//     Renders grouped `[Badge] fields, [Badge] fields` + chevron.
//     NOTE: also requires < 5 total fields (the 5+ threshold escalates to
//     Rule 4 regardless of table count — see §Row design Rule 4 thresholds).
//
//   Rule 4 — Multi-table complex
//     3+ distinct source tables, OR 5+ total sources.
//     Renders "N fields across M tables" summary + chevron. No inline badges
//     or field names.
//
// EDGE CASES (locked by founder 2026-04-24 prompt §Scope item 4):
//   • 1 source              → Rule 1
//   • 5 sources / 1 table   → Rule 4 (field-count threshold wins)
//   • 5 sources / 2 tables  → Rule 4 (field-count threshold wins)
//   • 3 sources / 3 tables  → Rule 4 (table-count threshold)
//   • 2 sources / 2 tables  → Rule 3 (below both Rule 4 thresholds)
//
// Thresholds kept as named constants so a spec revision can update them in
// one place without ripple across the component tree.

export type MappingRowRule = 'rule_1' | 'rule_2' | 'rule_3' | 'rule_4'

/** 3 or more distinct source tables triggers Rule 4 summary rendering. */
export const RULE_4_TABLE_COUNT_THRESHOLD = 3
/** 5 or more total sources triggers Rule 4 even if only 1-2 tables. */
export const RULE_4_SOURCE_COUNT_THRESHOLD = 5

/**
 * Classify a MappedRow's `sources` array into the four visual rendering rules.
 *
 * Precondition: `sources.length >= 1`. Zero-source mapped rows are a server-
 * side contract violation and are handled upstream by FieldMappingRow's
 * em-dash fallback; they MUST NOT reach this classifier.
 *
 * Pure function — no side effects, no allocations beyond a tiny Set for table-
 * id deduplication.
 */
export function classifyMappedRow(sources: MappingSourceRef[]): MappingRowRule {
  if (sources.length < 1) {
    // Defense-in-depth: callers should pre-filter, but we do not want to
    // silently return a wrong rule. Return rule_1 so the dispatcher falls
    // through to the simplest render path.
    return 'rule_1'
  }

  if (sources.length === 1) return 'rule_1'

  // Field-count threshold escalates to Rule 4 regardless of table count.
  if (sources.length >= RULE_4_SOURCE_COUNT_THRESHOLD) return 'rule_4'

  const tableCount = countDistinctSourceTables(sources)

  // Table-count threshold also escalates to Rule 4.
  if (tableCount >= RULE_4_TABLE_COUNT_THRESHOLD) return 'rule_4'

  // 2+ sources, 1-2 tables, < 5 sources.
  if (tableCount === 1) return 'rule_2'
  return 'rule_3' // tableCount === 2 (0 is impossible given sources.length >= 1)
}

/**
 * Count the number of unique `sourceTable.id` values across `sources`.
 * Returned as-is from a Set for O(n) time / O(k) space where k is the table
 * count — typically 1-3 in practice.
 */
export function countDistinctSourceTables(sources: MappingSourceRef[]): number {
  const ids = new Set<string>()
  for (const s of sources) {
    ids.add(s.sourceTable.id)
  }
  return ids.size
}
