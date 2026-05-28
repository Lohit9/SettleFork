/**
 * Synthesize a `fields.description` from a group of Rootstock JSON entries
 * that share the same (target_table, target_field). Pure function; the
 * Rootstock loader calls this once per target field before writing to the
 * `fields` table.
 *
 * Heuristic: take the prefix sentence (`Field type: X,
 * <Required|Optional|Conditionally Required>`) from the highest-confidence
 * entry, then append that same entry's first body paragraph (the prose
 * after the blank line, if present). Return null if no entry carries the
 * prefix; the UI falls back to `data_type` + required-ness rendering at
 * that tier.
 *
 * Multi-source caveat: for a target field with multiple mapped entries
 * (different source tables → same target), the chosen body may be
 * source-flavored. Acceptable because every multi-source target field in
 * the Rootstock spec (Item Number, Item Description, iccomcod external
 * id) is mapped in every partition → never rendered as empty slots →
 * source-flavored body is never surfaced in the fallback path.
 *
 * Assumes each (target_table, target_field) group is homogeneous —
 * either all-mapped or VA-only, never both. Mixed groups do not occur
 * in Rootstock JSON; if they ever did, prefix and body now come from
 * the same entry, so the result is internally consistent.
 */

export interface DescriptionEntry {
  source_table: string
  source_field: string
  explanation: string
  confidence: number
}

// Captures up to (but not including) any trailing period / parenthetical
// context after the required-ness indicator. We append a period back on
// in the caller so entries like `... Optional (inherits ...)` collapse
// down to `... Optional.` without leaking the parenthetical.
const PREFIX_RE =
  /^Field type: .+?, (?:Required|Optional|Conditionally Required)/m

const UNMAPPED = 'Unmapped'

export function extractTargetFieldDescription(
  entries: ReadonlyArray<DescriptionEntry>,
): string | null {
  if (entries.length === 0) return null

  // Two-pass stable sort: tiebreaker first (mapped > VA, then
  // lexicographic source), then confidence DESC. V8's stable sort
  // (ES2019) preserves the tiebreaker order on equal confidence.
  const ordered = [...entries].sort((a, b) => {
    const aMapped = a.source_table !== UNMAPPED ? 0 : 1
    const bMapped = b.source_table !== UNMAPPED ? 0 : 1
    if (aMapped !== bMapped) return aMapped - bMapped
    return `${a.source_table}|${a.source_field}`.localeCompare(
      `${b.source_table}|${b.source_field}`,
    )
  })
  ordered.sort((a, b) => b.confidence - a.confidence)

  const highest = ordered[0]!
  const prefixMatch = highest.explanation.match(PREFIX_RE)
  if (!prefixMatch) return null
  const prefix = `${prefixMatch[0]}.`

  const parts = highest.explanation.split(/\n\n+/)
  const body = parts[1] ? parts[1].trim() : ''

  const result = body ? `${prefix} ${body}` : prefix
  return result.length > 0 ? result : null
}
