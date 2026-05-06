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
 *
 * ── HOT-FIX 4 (May 2026) ──────────────────────────────────────────
 *
 * The previous content of this constant advertised three live
 * data-scanning tools (`query_field_data`, `count_distinct_patterns`,
 * `cross_field_correlation`) wired through `runAgentLoop` to RPCs in
 * migration 085. Production telemetry (Rootstock POC, May 2026)
 * surfaced mapping_generate calls succeeding (stop_reason='tool_use',
 * 1.7-13.7K output tokens) but persistence writing ZERO field
 * mappings — the AI was emitting tool_use for the data-scanning tools
 * in turns where it never produced an `emit_table_mappings` call,
 * and the agent loop was draining iterations / cost-cap before
 * reaching the structured emit.
 *
 * Hot-fix: empty the guidance constant so the AI is no longer
 * advertised these tools. HOT-FIX 5 (same incident, same PR)
 * additionally removes the tool registrations from
 * `runSingleAgentMappingLoop`'s tools array — without registration,
 * the AI cannot call them even if it tries. Combined effect: the
 * model goes straight to `emit_table_mappings`. Mappings persist again.
 *
 * Proper fix (deferred to a follow-up PR): re-evaluate whether the
 * agent-loop infrastructure actually delivers measurable lift on
 * mapping quality vs. the simpler single-shot path. If yes, restore
 * the guidance + tighten the loop's max-iterations / max-cost
 * thresholds. If no, retire the agent path entirely along with the
 * data-scanning tools and migration 085 RPCs.
 *
 * The export is preserved (empty string) so existing consumers
 * (`MAPPING_GENERATION_AGENT_SYSTEM_PROMPT = ... + '\n\n' +
 * AGENT_TOOL_GUIDANCE`, plus the 4 multi-agent BASE strings) compose
 * cleanly without a code change at every consumer.
 */

export const AGENT_TOOL_GUIDANCE = ''
