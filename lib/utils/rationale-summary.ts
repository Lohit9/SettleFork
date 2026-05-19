// One-line rationale summary for the mapping table's RATIONALE column.
//
// Pure function — no imports beyond this file, no DOM, no React, safe to
// unit-test in isolation. Used by `MappingListView`'s flat row renderer
// to derive a headline from the longer-form prose that lives on
// `MappedRow.aiReasoning` / `ValueAssignmentRow.aiReasoning` /
// `source_field_acknowledgments.reason`. The drawer still renders the
// full text.
//
// Rules (matches the founder spec):
//   1. Trim. Empty / null / whitespace-only → return null.
//   2. Strip a leading "Field type: …" sentence (the AI mapper often
//      leads with type-compat boilerplate before the actual rationale).
//   3. Take the first sentence of what remains. A sentence ends at the
//      first `.`, `!`, or `?`. If none exists, take the full remainder.
//   4. Truncate to ~120 chars with a trailing ellipsis (the Unicode `…`
//      single-glyph form). Counts the ellipsis toward the cap so the
//      total visible width stays bounded.
//   5. If steps 2-3 leave nothing, return null. Callers render em-dash.

const MAX_LEN = 120

export function summarizeRationale(
  input: string | null | undefined,
): string | null {
  if (input == null) return null
  let text = input.trim()
  if (text.length === 0) return null

  // Strip a leading "Field type: …" sentence (case-insensitive).
  // Matches up to and including the first sentence terminator after
  // the "Field type" lead. If the input is ONLY the Field-type
  // sentence, the remainder is empty and we return null below.
  text = text.replace(/^Field type[^.!?]*[.!?]\s*/i, '').trim()
  if (text.length === 0) return null

  // Take the first sentence. A sentence is the substring up to and
  // including the first terminator. If no terminator exists, the
  // whole remainder is the "sentence."
  const match = text.match(/^[^.!?]*[.!?]/)
  let first = (match ? match[0] : text).trim()
  if (first.length === 0) return null

  if (first.length > MAX_LEN) {
    // Reserve one slot for the ellipsis glyph; trim trailing whitespace
    // before appending so we never produce "word …".
    first = first.slice(0, MAX_LEN - 1).trimEnd() + '…'
  }
  return first
}
