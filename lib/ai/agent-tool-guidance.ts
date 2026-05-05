/**
 * Shared `AGENT_TOOL_GUIDANCE` block — appended to every Phase 3
 * agent-mode system prompt (PR 3.4a `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT`
 * + the 4 multi-agent system prompts in PR 3.4cd).
 *
 * Lives in a dependency-free module to avoid a circular-import cycle
 * between `mapping-engine.ts` (which composes it into the legacy
 * agent system prompt) and `multi-agent-prompts.ts` (which composes
 * it into each of the 4 multi-agent system prompts) — both of which
 * are reachable from `multi-agent-orchestrator.ts`, which mapping-engine.ts
 * itself imports.
 *
 * Originally lived in `mapping-engine.ts` (PR 3.4a). PR 3.4cd commit 4
 * extracted it here when the runtime cycle surfaced (TypeScript's
 * type-check passed but the module-top-level access of the const
 * during cyclic load hit a temporal-dead-zone error).
 */

export const AGENT_TOOL_GUIDANCE = `
DATA-SCANNING TOOLS — when to use them and when not to.

You have access to three tools that query the actual source data live. The static prompt above already contains aggregate stats and the top sample values per field. Use the tools ONLY when the static prompt is insufficient for a specific decision; they cost real time and tokens.

query_field_data(table_id, field_name, where_filter?, limit?)
  WHEN: aggregate stats show drift (high cardinality with format hints) OR documentation describes target picklist values that need cross-checking against actual source values. Returns up to 50 row values for one field, optionally filtered by a single column condition.
  WORKED EXAMPLE: target Account.Status has documented picklist ["Open", "Closed", "Pending"]. Source customer_status shows cardinality 7 but only top-5 distinct values in samples. Call query_field_data on customer_status with limit=20 to see whether the remaining 2 values are typos vs. genuinely different categories.

count_distinct_patterns(table_id, field_name, limit?)
  WHEN: deciding enum-vs-freeform target field, validating expected boolean encoding (Y/N vs 0/1 vs true/false), or checking whether a source field is functionally a foreign key (low cardinality + repeated values). Returns up to 30 distinct values ordered by frequency desc.
  WORKED EXAMPLE: source customer_status has 14 distinct values, target Account.Status is a 6-value picklist per documentation. Call count_distinct_patterns(customer_status, limit=15) to see which 6 source values dominate — those are your value-translation rules; the long tail is data quality / one-off cleanup.

cross_field_correlation(table_id, field_a_name, field_b_name)
  WHEN: deciding whether two source fields should combine into one target (many_to_one — first_name + last_name → full_name), or validating a conditional-required rule (e.g., \`amount\` must not be NULL when \`status='Closed Won'\`). Returns joint frequency + per-A conditional null rates of B for the top 25 pairs.
  WORKED EXAMPLE: target Account.PrimaryContact looks like it combines source contact_first + contact_last. Call cross_field_correlation(contact_first, contact_last) to verify; extreme conditional null rates mean the pairing is one_to_many in disguise, not many_to_one.

HARD LIMITS
- Prefer ≤3 tool calls per source-table batch. Each costs roughly as much as the initial reasoning step.
- If the first call doesn't resolve ambiguity, do NOT chain speculatively — emit \`emit_table_mappings\` and explain residual uncertainty in \`reasoning\`.
- Tools are for TARGETED checks, not bulk inspection. The static prompt already includes up to 50 sample values per field.

WHAT NOT TO DO
- Do NOT call a data-scanning tool when the static prompt's stats already contain the answer (cardinality, null %, format issues, top distinct values).
- Do NOT call query_field_data without a \`where_filter\` just to scan rows — use the filter to investigate edge cases (NULLs, format outliers, boundary conditions).
- Do NOT call cross_field_correlation across tables — the RPC rejects mismatched table_id.`
