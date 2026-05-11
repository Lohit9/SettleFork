/**
 * POC override token substitution.
 *
 * Replaces `{{key}}` placeholders in answer-key markdown with values from
 * the `projects.poc_overrides` JSONB column. Missing keys leave the
 * `{{placeholder}}` token intact — silent data loss would let a typo in
 * the overrides JSONB ship a broken answer key to the model without any
 * detectable signal. Leaving the literal token in place makes the gap
 * visible in the next llm_calls.user_message inspection.
 *
 * Consumed by `buildAIContext` (Task 3) when a project has
 * `poc_template IS NOT NULL`; runs the answer-key markdown through this
 * function before folding it into the Path D user message.
 *
 * Pure function — no I/O, no env reads. Safe to call with any record
 * shape; non-string values are coerced via `String()` (matches the
 * behaviour callers expect when overrides come straight from JSONB,
 * where numbers / booleans pass through Postgres unchanged).
 *
 * Sunset: INF-73 (single removal PR after iter-3 ships generic
 * multi-entity authoring + answer-key-style decision/lookup output).
 */
export function applyPocOverrides(
  template: string,
  overrides: Record<string, unknown>,
): string {
  if (!overrides || Object.keys(overrides).length === 0) {
    return template
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = overrides[key]
    if (value === undefined || value === null) return match
    return String(value)
  })
}
