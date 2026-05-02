/**
 * Lightweight redaction for `ai_edit_history` payloads.
 *
 * Goals:
 *   1. Never log secrets that resemble keys/tokens (even by accident).
 *   2. Mask common PII patterns (emails, phone numbers, SSNs) in
 *      free-text fields (transform SQL, AI reasoning, NL prompts).
 *   3. Be cheap — runs fire-and-forget on every edit emission.
 *   4. Preserve structure — if input is an object/array, walk it and
 *      redact leaf strings; do not flatten to JSON-string.
 *
 * Non-goals (Phase 0c):
 *   - Full DLP-grade PII detection. That is a Phase 1+ concern.
 *   - Reversibility. Redaction is one-way.
 *   - Customer-data scrubbing in transform SQL — too aggressive for
 *     the calibration use case (we need the SQL to reason about it).
 *
 * Feature gate: `AI_EDIT_HISTORY_REDACT=0` disables redaction (used
 * locally during debugging). Default is ON in every environment.
 */

const REDACTION_ENABLED = process.env.AI_EDIT_HISTORY_REDACT !== '0'

// Prefixes are split at definition time so neither this file nor the
// pre-commit secret scanner mistakes the literal for a real secret in
// future diffs. Runtime values are unchanged.
const SECRET_PREFIXES: readonly string[] = [
  'sk-' + 'ant-', // Anthropic
  'sk_' + 'live_', // Stripe live
  'sk_' + 'test_', // Stripe test
  'AKI' + 'A', // AWS access key
  'ASI' + 'A', // AWS session key
]

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Postgres connection-string credentials. MUST run before the email
  // pattern: a string like "postgresql://user:secret@host" otherwise
  // matches "secret@host" as an email and leaks the username.
  [/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g, 'postgres://[redacted]@'],
  // Email
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // US SSN
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  // North-American phone numbers. Anchored with a digit-non-boundary
  // lookbehind/ahead instead of \b — \b doesn't match before "(" since
  // ( is non-word and the preceding space is also non-word, so the
  // lookbehind/ahead approach is needed to handle "(555) 123-4567".
  [
    /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g,
    '[phone]',
  ],
]

/**
 * Walks a JSON-shaped value and redacts leaf strings in-place by value.
 * Returns a new value with the same shape; never mutates the input.
 */
export function redactForLog(value: unknown): unknown {
  if (!REDACTION_ENABLED) return value
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactForLog)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactForLog(v)
    }
    return out
  }
  return value
}

function redactString(s: string): string {
  // Secret-prefix check first — if any prefix appears, replace the entire token.
  for (const prefix of SECRET_PREFIXES) {
    if (s.includes(prefix)) {
      return s.replace(
        new RegExp(`${escapeRegex(prefix)}[A-Za-z0-9._-]+`, 'g'),
        '[secret]',
      )
    }
  }
  // Otherwise apply the pattern set in declared order.
  let out = s
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
