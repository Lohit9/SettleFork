/**
 * INV-1 PR-A — `AGENT_PROVENANCE_GUIDANCE` shared block + helpers.
 *
 * INV-1 surfaced that the strongest priority signal in the codebase
 * (`schema_source='manual'` on user-edited fields) is *invisible* at
 * read-time — `formatSchemaForPrompt` deliberately drops the label
 * (see comment at lib/ai/context-builder.ts:24-25). The corresponding
 * write-path cascade at `SCHEMA_SOURCE_PRIORITY` (lib/utils/schema-priority.ts)
 * protects user edits from being clobbered, but no agent receives the
 * "this was user-authored" signal.
 *
 * PR-A closes the gap with two surfaces, both gated behind
 * `AI_PROVENANCE_LABELS_ENABLED=1`:
 *   1. `formatSchemaForPrompt` emits the provenance label as an inline
 *      field flag (`[manual]`, `[ddl_parsed]`, etc.) when not 'inferred'.
 *   2. Every adopting agent's system prompt is prepended with this
 *      block, which encodes the principal's 4-tier priority framework
 *      and tells the model how to treat the new flags.
 *
 * Flag-OFF heritage byte-identical preserved — callsites use
 * `withProvenanceGuidance(prompt)` which returns the original prompt
 * verbatim when the flag is unset.
 *
 * Lives in a dependency-free module so any agent file can import it
 * without risking a circular-import cycle (mirrors agent-tool-guidance.ts).
 *
 * Design refs: docs/investigations/inv1-input-prioritization.md §G.1
 *              + §G.4 Q1.
 */

// ─── Constant content ──────────────────────────────────────────────────────

/**
 * The 4-tier input-prioritization framework, written for direct paste
 * into a system prompt. Tells the model how to weigh user edits vs
 * documentation vs raw data when sources conflict.
 *
 * Locked content — referenced by `tests/lib/agent-provenance-guidance.test.ts`
 * for source-text invariants.
 */
export const AGENT_PROVENANCE_GUIDANCE = `INPUT PRIORITIZATION — read this before reasoning about the user's data.

When sources conflict, follow this authority order strictly:

P1 (HIGHEST) — User schema overview edits. Any field tagged with [manual] in the structured schema was explicitly edited by the user in the Schema Overview tab. Treat the user's edit as authoritative; do NOT propose a mapping or transformation that contradicts it. If a documentation file disagrees with a [manual]-tagged field, prefer the user's edit and surface the doc's version only as additional context if it is value-level (e.g., picklist values), not structural (e.g., nullability).

P2 — Schema documents (DDL, ERDs, data dictionaries). Tagged [ddl_parsed] or [doc_enriched] in the structured schema, and additionally surfaced verbatim inside <schema_documentation>. These are the next authority for STRUCTURAL claims (data types, nullability, primary/foreign keys, CHECK constraints). They do NOT override P1 user edits. If a [ddl_parsed] / [doc_enriched] field disagrees with the schema documentation, the structured schema wins (it has already been reconciled).

P3 — Business documents (free-text rules, value mappings, requirements). Surfaced inside <business_context>. These are the authority for VALUE-LEVEL and SEMANTIC claims (how to interpret a code, what "valid" means, how a field maps to business rules). They do NOT override structural claims from P1 or P2.

P4 (LOWEST) — Raw data (sample values, value distributions, null rates, format-issues counts surfaced as Stats:/Values:/Samples: lines inside <source_schema> and <target_schema>; live tool output from query_field_data / count_distinct_patterns / cross_field_correlation if you call those tools). Use raw data to VERIFY structural claims, identify edge cases, and inform value-level decisions. Do NOT use raw data to override higher-authority sources when they disagree — for example, do not infer a different data type than the structured schema declares just because the samples look ambiguous.

PROVENANCE FLAGS in the structured schema:
- [manual] — P1, set when the user edited this field in Schema Overview. Always wins.
- [ddl_parsed] — P2, parsed directly from a DDL upload or live database introspection.
- [doc_enriched] — P2, set by AI enrichment after reading a schema documentation upload.
- [cross_table_inferred] — P4 (corroborated), inferred from name/value overlap with sibling tables.
- (no flag) — P4, value inferred from CSV header + value sampling.

When two sources at the same tier disagree, prefer the more specific signal (a CHECK constraint over a free-text picklist; a sample value distribution over a generic samples list).`

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Returns the inline field-flag string for a given `schema_source` value.
 * Empty string for the default 'inferred' case (no flag emitted) — keeps
 * prompts terser when there is no provenance signal to surface.
 *
 * Surface contract: the returned string is the FLAG TEXT only (no
 * brackets in the input — brackets are added by the caller's flag-list
 * formatter to match existing PK / FK / nullable / semantic flags).
 *
 * Parameter type is widened to `string` so unrecognised values from
 * legacy rows (or future labels we haven't added yet) resolve to ''
 * rather than throwing.
 */
export function provenanceFlagFor(schemaSource: string | null | undefined): string {
  switch (schemaSource) {
    case 'manual':
      return 'manual'
    case 'ddl_parsed':
      return 'ddl_parsed'
    case 'doc_enriched':
      return 'doc_enriched'
    case 'cross_table_inferred':
      return 'cross_table_inferred'
    case 'inferred':
    case null:
    case undefined:
    default:
      return ''
  }
}

/**
 * Reads the runtime feature flag. Exact-match `'1'`; any other value
 * (including unset, empty string, `'0'`, `'true'`) reads as OFF.
 * Mirrors `AI_PHASE_3_ENABLED` semantics per CLAUDE.md §4.5.1.
 *
 * Read fresh on every call so per-test env var manipulation works
 * without `vi.resetModules()` rituals.
 */
export function provenanceLabelsEnabled(): boolean {
  return process.env.AI_PROVENANCE_LABELS_ENABLED === '1'
}

/**
 * Conditionally prepend `AGENT_PROVENANCE_GUIDANCE` to a system prompt.
 * Callsites use this at the moment the systemPrompt argument is
 * constructed for `callLLM` / `runAgentLoop`:
 *
 *   const result = await callLLM({
 *     systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_SYSTEM_PROMPT),
 *     ...
 *   })
 *
 * Flag-OFF: returns `prompt` verbatim — heritage byte-identical
 * preserved. Flag-ON: prepends AGENT_PROVENANCE_GUIDANCE plus a blank
 * line so the existing system-prompt content stays visually separate.
 *
 * Does NOT modify the underlying constants (e.g., MAPPING_GENERATION_SYSTEM_PROMPT
 * stays byte-identical regardless of flag state). This preserves
 * existing source-text test pins on those constants.
 */
export function withProvenanceGuidance(prompt: string): string {
  if (!provenanceLabelsEnabled()) return prompt
  return `${AGENT_PROVENANCE_GUIDANCE}\n\n${prompt}`
}
