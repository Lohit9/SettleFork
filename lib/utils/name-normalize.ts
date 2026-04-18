/**
 * Normalize a table or field name for fuzzy comparison.
 * Strips underscores, hyphens, and whitespace, then lowercases.
 *
 * MATCHING-ONLY helper: never use this to rename a table or field in the
 * database or UI. Display names stay verbatim; normalization is an internal
 * key so that DDL identifiers ("BRANCH_INFO") line up with user-entered
 * display names ("Branch Info") when the two sources are reconciled.
 *
 * Examples:
 *   "Branch Info"  → "branchinfo"
 *   "BRANCH_INFO"  → "branchinfo"
 *   "branch-info"  → "branchinfo"
 *   "CIF_MASTER"   → "cifmaster"
 *   "CIF Master"   → "cifmaster"
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]+/g, '')
}
