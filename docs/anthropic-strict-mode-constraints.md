# Anthropic Strict-Mode Tool-Schema Constraints

Cumulative catalog of constraints discovered when authoring tool-use schemas under Anthropic's strict-mode enforcement. Each constraint was empirically discovered (HTTP 400 schema rejection or runtime error) and is reproducible.

This document is the canonical reference for future schema work in [`lib/ai/tool-schemas.ts`](../lib/ai/tool-schemas.ts). Default to the patterns documented at the bottom of this file.

## Constraints (chronological order of discovery)

### 1. `additionalProperties: false` is required on every nested object

**Discovered:** PR 12.1
**Symptom:** Strict-mode rejection on tool schemas with implicit/permissive object shapes. Anthropic's API responds with: `For 'object' type, 'additionalProperties' must be explicitly set to false`.
**Pattern:** Every nested object schema must explicitly declare `additionalProperties: false`. The schema enforcement is recursive — nested objects within `properties.X.items.properties` etc. must each have it.

### 2. `oneOf` is rejected entirely

**Discovered:** PR 12.1.5 B-2 (probe attempt for variant-template support on `EMIT_PARSED_DDL_TOOL.checkConstraint`).
**Symptom:** HTTP 400 on the schema with `oneOf` anywhere in the tree.
**Workaround:** Use `additionalProperties: false` + enumerated optional keys. Different variants can coexist as optional keys with descriptions guiding which subset to use per discriminator value. See [`lib/ai/tool-schemas.ts:482`](../lib/ai/tool-schemas.ts) (`checkConstraint`'s description encodes the 4-variant shape that `oneOf` would have expressed structurally).

### 3. `additionalProperties: true` is rejected

**Discovered:** Path 2 PR 1 (PR #29).
**Symptom:** HTTP 400 on schemas with `additionalProperties: true` on nested objects (the explicit-permissive variant).
**Workaround:** Replace with explicit `properties` block enumerating all expected keys + `additionalProperties: false`. PR 12.1.5's enriched per-type/per-category descriptions encode which keys belong to each variant. Affected sites in Path 2 PR 1: `rule_config` (validation rules), `pattern_config` (extracted patterns), `checkConstraint` (parsed DDL).

### 4. `minimum` / `maximum` on numbers is rejected

**Discovered:** PR 12.1.
**Workaround:** Encode numeric ranges in description text. Use `type: 'number'` (or `type: 'integer'`) without min/max constraints.

### 5. `minItems` / `maxItems` on arrays is rejected

**Discovered:** PR 12.1.
**Workaround:** Encode count ranges in description text. Use `type: 'array', items: {...}` without count constraints.

### 6. Grammar-compilation 503 on schemas of significant size (TRANSIENT)

**Discovered:** Path 2 PR 2 B-2 (PR #34).
**Symptom:** Anthropic API returns HTTP 503 with `overloaded_error: Grammar compilation is temporarily unavailable. Please try again.` and `x-should-retry: false` header. Affects `EMIT_EXTRACTED_PATTERNS_TOOL` (largest strict-mode schema; 4 categories with per-category enumerated vocabularies embedded in description). Reproduced 4 times in a row during the B-2 verification window.
**Status:** External service issue, not a schema defect. Other strict-mode tools (`EMIT_MAPPING_TOOL`, `EMIT_VALIDATION_RULE_TOOL`, `EMIT_MAPPING_SUGGESTION_TOOL`, `EMIT_QUALITY_ISSUES_TOOL`, `EMIT_FIX_OPTIONS_TOOL`) work in the same window. Re-runs eventually succeed.
**Mitigation:** Retry with backoff at the application level. The SDK does not auto-retry due to `x-should-retry: false`. If a schema reliably 503s, consider whether the description-embedded vocabulary can be split across a smaller set of more-specific tools. (Speculative — not yet attempted.)

## Default schema pattern (canonical)

When authoring a new strict-mode tool schema in [`lib/ai/tool-schemas.ts`](../lib/ai/tool-schemas.ts), default to:

1. **Top-level shape:** `{ type: 'object', properties: {...}, required: [...], additionalProperties: false }`.
2. **Nested objects:** Same pattern. Always `additionalProperties: false`.
3. **Numeric ranges, count constraints, enum semantics not expressible as JSON Schema enums:** Encode in description text.
4. **Variant templates:** Use `additionalProperties: false` + enumerated optional keys + per-key descriptions guiding category-specific usage.
5. **No `oneOf`, no `additionalProperties: true`, no `minimum`/`maximum`, no `minItems`/`maxItems`.**

## Reference implementations

- [`EMIT_VALIDATION_RULE_TOOL`](../lib/ai/tool-schemas.ts) — `rule_config` enumerates 9 optional keys for the 5 rule types (Path 2 PR 1's reference)
- [`EMIT_EXTRACTED_PATTERNS_TOOL`](../lib/ai/tool-schemas.ts) — `pattern_config` enumerates 14 keys across 4 categories (Path 2 PR 1's reference + B-2's 503 caveat)
- [`EMIT_PARSED_DDL_TOOL`](../lib/ai/tool-schemas.ts) — `checkConstraint` with 6 enumerated keys + a descriptor-string discriminator (Path 2 PR 1's reference, post-`oneOf`-probe)

## Lessons (compressed)

- Anthropic's strict-mode rejection model is "structural keys + descriptions for everything else."
- Description text is the only mechanism for non-structural constraints — it's load-bearing for behavior.
- Empirically discovered constraints come at the cost of one HTTP 400 + investigation cycle each; this catalog is the cumulative receipt.
- Schema authors should test under flag-ON before assuming a feature works.
