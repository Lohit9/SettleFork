// @vitest-environment node
//
// Regression pins for the `generateMappings` orchestration, post-PR-4
// extraction. PR 4 split the function: `generateMappings` in
// `lib/actions/mappings.ts` is now the thin wrapper (auth, rate-limit,
// validation, `existingPairSet` construction, delegate); the bulk of
// the AI work — batch loop, Claude calls, parse+retry, persistence,
// collision-collapse — lives in `runMappingGeneration` and
// `persistClaudeFieldMappingsForTM` in `lib/ai/mapping-engine.ts`.
// This file pins both halves.
//
// Tested behaviors (groups A–G; group letters preserved across the
// PR 3 → PR 4 evolution):
//   A. MAPPING_GENERATION_SYSTEM_PROMPT content (verbatim section pins)
//      → engine
//   B. PER_BATCH_MAX_TOKENS = 16000, used in both the main call and
//      the JSON-repair retry → engine
//   C. Batch loop iterates per-source-table and emits an
//      `<other_source_tables>` block in the user message → engine
//   D. JSON parse → on failure, retry with the JSON-repair system
//      prompt, same token budget; on retry failure, skip this batch
//      and continue → engine
//   E. Many-to-one collision collapse in
//      `persistClaudeFieldMappingsForTM`: same target across two
//      field_mappings → single TFM, contributor appended,
//      combinationType forced to 'concat_space' → engine
//   F. Persistence shape: `dq_create_target_field_mapping` RPC called
//      with p_project_id, p_target_field_id, p_sources (ordinals
//      primary=0, contributor=1+), p_combination.type → engine
//   G. Error paths: zero-stored fallthrough → engine; rate-limit
//      returns 'VALIDATION' → wrapper; individual Claude throw is
//      non-fatal (continue) → engine; auth ordering → wrapper;
//      existing-pair skip path → mixed (set built in wrapper, applied
//      in engine).
//
// ─────────────────────────────────────────────────────────────────────
// APPROACH — source-text invariants, not behavioral mocks.
// ─────────────────────────────────────────────────────────────────────
//
// Every existing test for legacy/redesign mapping actions in this repo
// uses the source-text-invariant pattern: read the SUT file as text
// and assert specific call-site shapes are present. The convention is
// documented at `tests/actions/mappings-for-redesign-actions.test.ts:8-18`
// with the rationale "Spinning up a full mocking harness for every
// codepath is expensive; instead we read the source file and assert
// the call-site shape locks the founder-locked decisions in place. A
// future refactor that silently drops a refinement cannot land
// without breaking CI." Sibling examples:
// `mappings-refinements.test.ts`, `mappings-guard-sweep.test.ts`,
// `mappings-for-redesign-phase-4a-actions.test.ts`.
//
// This file follows that convention. No production code is loaded; no
// mocks are set up. Each test reads either `lib/actions/mappings.ts`
// (wrapper concerns) or `lib/ai/mapping-engine.ts` (orchestration
// concerns) and asserts substrings or regex patterns are present in
// named slices of those files. A refactor that drops any pinned
// behavior (a section header, a constant value, a structural pattern,
// an error code, an ordering invariant) breaks one or more tests here.
//
// ─────────────────────────────────────────────────────────────────────
// BRITTLENESS WARNING — do not reformat the SUT files between PR 4 and
// the next refactor.
// ─────────────────────────────────────────────────────────────────────
//
// PR 4 split the orchestration: `generateMappings` in
// `lib/actions/mappings.ts` is now a thin wrapper (auth + rate-limit +
// validation + `existingPairSet` construction + delegate). The bulk
// of the AI work moved to `runMappingGeneration` in
// `lib/ai/mapping-engine.ts`. This file pins both halves.
//
// Some assertions slice the source by indentation- and brace-aware
// end-markers (e.g. D3's `'}\n      }\n    }'`, F4's `^\s{6}p_`
// line-prefix scan, G2's catch-block boundary). These hold against
// logic-preserving edits but break under cosmetic reformatting
// (Prettier reflow, indentation width change, trailing-comma policy
// shift). Between this PR's merge and the next refactor, treat BOTH
// `lib/actions/mappings.ts` and `lib/ai/mapping-engine.ts` as
// format-frozen: only logic edits, no reformatting passes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LEGACY_PATH = resolve(__dirname, '../../lib/actions/mappings.ts')
const LEGACY_SRC = readFileSync(LEGACY_PATH, 'utf8')

const ENGINE_PATH = resolve(__dirname, '../../lib/ai/mapping-engine.ts')
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

function sliceFrom(src: string, startMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(a)
}

// ─── WRAPPER slice (legacy file) ──────────────────────────────────────
//
// Body of the thin `generateMappings` wrapper. Pins wrapper-only
// concerns: auth, rate-limit, validation, `existingPairSet`
// construction, delegation to `runMappingGeneration`.
const GENERATE_BODY = sliceBetween(
  LEGACY_SRC,
  'export async function generateMappings(',
  'export async function getMappings(',
)

// ─── ENGINE slices (mapping-engine.ts) ────────────────────────────────
//
// Body of `runMappingGeneration`, the orchestrator. Pins the bulk of
// the AI work: batch loop, Claude calls, JSON parse + retry,
// per-source-table iteration, persistence flow, error returns.
// Bounded at the suggestion-path section header that PR 5 added —
// without that bound, C1.3's `callClaude(` count would also pick up
// `runMappingSuggestion`'s Claude call.
const RUN_GEN_BODY = sliceBetween(
  ENGINE_SRC,
  'export async function runMappingGeneration(',
  '// ─── Mapping suggestion: prompts + types',
)

// Body of the system-prompt constant declaration. Bounded by the next
// section header in the engine (the read-path's row-builder section).
const SYSTEM_PROMPT_BLOCK = sliceBetween(
  ENGINE_SRC,
  'export const MAPPING_GENERATION_SYSTEM_PROMPT',
  '// ─── Row builders',
)

// Body of the `buildMappingUserMessage` helper. Bounded by the
// pure-assembly section.
const USER_MESSAGE_BUILDER = sliceBetween(
  ENGINE_SRC,
  'export function buildMappingUserMessage(',
  '// ─── Pure assembly',
)

// Body of `persistClaudeFieldMappingsForTM`. The collision-collapse
// algorithm lives here. Bounded by the orchestrator section header.
const PERSIST_BODY = sliceBetween(
  ENGINE_SRC,
  'export async function persistClaudeFieldMappingsForTM(',
  '// ─── Mapping generation: orchestrator',
)

// Body of `parseClaudeJSON`. Bounded by the next exported helper.
const PARSE_JSON_BODY = sliceBetween(
  ENGINE_SRC,
  'export function parseClaudeJSON(',
  'export function buildMappingUserMessage(',
)

// ─────────────────────────────────────────────────────────────────────
// Group A — System prompt content (verbatim section pins)
// ─────────────────────────────────────────────────────────────────────
//
// These pin the prompt that drives Claude. A subtle wording change
// across extraction would silently shift Claude's behavior. The pins
// are deliberately brittle.

describe('[generateMappings] A1 — system prompt: TRANSFORMATION RULES section', () => {
  it('contains the verbatim "TRANSFORMATION RULES" header', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('TRANSFORMATION RULES')
    // The literal trigger sentence below the header — pins the
    // semantics, not just the words.
    expect(SYSTEM_PROMPT_BLOCK).toContain('A field needs_transformation = true if ANY of these apply')
  })
})

describe('[generateMappings] A2 — system prompt: all 9 numbered transformation rules', () => {
  // Each numbered rule is pinned by its leading "N. NAME:" anchor.
  // Wording inside each rule is allowed to evolve; the anchor + count
  // is what pins the taxonomy.
  const ANCHORS = [
    '1. DATA TYPE CONVERSION',
    '2. VALUE MAPPING',
    '3. FORMAT STANDARDIZATION',
    '4. ID FORMAT CHANGE',
    '5. BOOLEAN NORMALIZATION',
    '6. CASING / CAPITALIZATION',
    '7. TRUNCATION',
    '8. COMPUTATION',
    '9. FOREIGN KEY REFORMAT',
  ]
  for (const anchor of ANCHORS) {
    it(`contains the "${anchor}" rule anchor`, () => {
      expect(SYSTEM_PROMPT_BLOCK).toContain(anchor)
    })
  }
})

describe('[generateMappings] A3 — system prompt: MULTI-FIELD MAPPING PATTERNS section', () => {
  it('contains the verbatim section header', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('MULTI-FIELD MAPPING PATTERNS')
  })

  it('describes both MANY-TO-ONE and ONE-TO-MANY patterns', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('MANY-TO-ONE')
    expect(SYSTEM_PROMPT_BLOCK).toContain('ONE-TO-MANY')
  })

  it('pins the many-to-one contract: contributing_source_fields array NOT repeating the primary', () => {
    // The instruction "do NOT repeat the primary" is what makes the
    // collision-collapse logic sane. If the prompt drifts, Claude
    // starts emitting the primary in the contributor list and the
    // collapse algorithm needs to compensate.
    expect(SYSTEM_PROMPT_BLOCK).toMatch(/contributing_source_fields[\s\S]*do NOT repeat the primary/)
  })
})

describe('[generateMappings] A4 — system prompt: TABLE-LEVEL MATCHING section', () => {
  it('contains the verbatim section header', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('TABLE-LEVEL MATCHING')
  })

  it('pins the lookup-vs-entity discrimination rule (LOOKUP / REFERENCE TABLES)', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('LOOKUP / REFERENCE TABLES')
    expect(SYSTEM_PROMPT_BLOCK).toContain('ENTITY TABLES')
  })

  it('pins the WEAK-OVERLAP RULE that prevents low-quality cross-table mappings', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('WEAK-OVERLAP RULE')
  })

  it('pins the PRIMARY-MATCH RULE used by the per-source-table batching path', () => {
    expect(SYSTEM_PROMPT_BLOCK).toContain('PRIMARY-MATCH RULE')
  })
})

describe('[generateMappings] A5 — system prompt: closing JSON-only instruction', () => {
  it('ends with the verbatim CRITICAL closing line', () => {
    // This is the contract that lets `parseClaudeJSON` skip the
    // markdown-fence stripping in the common case. Drift here breaks
    // the pure-JSON assumption downstream.
    expect(SYSTEM_PROMPT_BLOCK).toContain(
      'CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group B — Token budget pins
// ─────────────────────────────────────────────────────────────────────

describe('[generateMappings] B1 — PER_BATCH_MAX_TOKENS = 32000 (May 2026 streaming bump)', () => {
  it('declares PER_BATCH_MAX_TOKENS = 32000 inside runMappingGeneration (engine)', () => {
    // May 2026 incident: bumped 16000 → 32000 to fit the structured
    // emit_table_mappings tool input on projects with 100+ field-pair
    // sets without truncation. The bump is paired with a switch to
    // callLLMStreaming on the primary call (B2 below).
    expect(RUN_GEN_BODY).toMatch(/const\s+PER_BATCH_MAX_TOKENS\s*=\s*32000\b/)
  })

  it('passes PER_BATCH_MAX_TOKENS via the callLLMStreaming options object on the primary call', () => {
    // May 2026 incident: the primary AI call goes through
    // `callLLMStreaming(opts)` (was `callLLM` pre-incident). Streaming
    // unlocks the 32k token budget without the previous
    // non-streaming truncation behaviour. Argument shape stays the
    // same — pin the four key fields so a refactor that drops any of
    // them breaks CI.
    expect(RUN_GEN_BODY).toMatch(
      /callLLMStreaming\(\{[\s\S]{0,800}feature:\s*['"]mapping_generate['"]/,
    )
    // PR-A wrapped the bare constant in `withProvenanceGuidance(...)`
    // so the prompt picks up the 4-tier priority block at flag-ON.
    // Allow either form so this pin is forward-compatible if PR-A is
    // ever rolled back.
    expect(RUN_GEN_BODY).toMatch(
      /callLLMStreaming\(\{[\s\S]{0,800}systemPrompt:\s*(?:withProvenanceGuidance\()?MAPPING_GENERATION_SYSTEM_PROMPT/,
    )
    expect(RUN_GEN_BODY).toMatch(
      /callLLMStreaming\(\{[\s\S]{0,800}userMessage:\s*batchUserMessage/,
    )
    expect(RUN_GEN_BODY).toMatch(
      /callLLMStreaming\(\{[\s\S]{0,800}maxTokens:\s*PER_BATCH_MAX_TOKENS/,
    )
  })
})

describe('[generateMappings] B2 — JSON-repair retry uses the same 32000-token budget', () => {
  it('passes PER_BATCH_MAX_TOKENS to the retry callLLM (not a different literal)', () => {
    // The retry block should reference the same constant, not a
    // different magic number. This pins the "same budget on retry"
    // contract — Claude needs the full budget to actually correct a
    // malformed response.
    //
    // Post-PR-6 end-marker: the retry block ends in
    // `parseClaudeJSON(retryResult.text)` (was `parseClaudeJSON(retryRaw)`
    // pre-PR-6 when the call returned a raw string).
    const retrySlice = sliceBetween(
      RUN_GEN_BODY,
      'JSON repair tool',
      'parseClaudeJSON(retryResult.text)',
    )
    expect(retrySlice).toContain('PER_BATCH_MAX_TOKENS')
    // Defensive: there should be no inline `1024` / `4096` / `2048`
    // literal in the retry slice (those would suggest a hardcoded
    // smaller budget snuck in).
    expect(retrySlice).not.toMatch(/\b(1024|2048|4096|8000)\b/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group C — Batch behavior (one Claude call per source table)
// ─────────────────────────────────────────────────────────────────────

describe('[generateMappings] C1 — one Claude call per source table, not per pair', () => {
  it('iterates the source-tables array, not a Cartesian product of source × target', () => {
    // The loop key: `for (let i = 0; i < sourceTablesForBatching.length; i++)`.
    // Crucially, there is no nested `for ... of targetTables` inside it.
    expect(RUN_GEN_BODY).toMatch(
      /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*sourceTablesForBatching\.length\s*;\s*i\+\+\s*\)/,
    )
  })

  it('declares sourceTablesForBatching = aiCtx.source_tables (single source iteration boundary)', () => {
    expect(RUN_GEN_BODY).toMatch(
      /const\s+sourceTablesForBatching\s*=\s*aiCtx\.source_tables/,
    )
  })

  it('does not call callLLM inside a target-table loop (no per-pair Claude call)', () => {
    // Pin: there is no `for (const tgt of targetTables) { … callLLM … }`
    // pattern inside the engine orchestrator. The only Claude calls
    // are in the single per-source-table loop and its retry.
    //
    // Post-PR-6: the wrapper is `callLLM` from `lib/ai/llm-client.ts`
    // (was `callClaude` from `lib/ai/claude.ts` pre-PR-6). Defensive
    // counts: zero `callClaude(` (proves PR 6's migration is complete
    // for runMappingGeneration). Post-PR-3.4cd commit 2: exactly TWO
    // `callLLM(` — legacy primary + legacy repair retry. The agent
    // path's schema_error fallback callLLM was extracted out of
    // runMappingGeneration into `lib/ai/single-agent-mapping.ts` along
    // with the rest of the 3.4b agent body. The C1 invariant (one
    // call per source-table, not per pair) holds: both remaining
    // callLLM-family invocations are inside the per-source-table
    // loop, not nested in a target-table loop.
    //
    // May 2026 streaming switch: the primary call now uses
    // callLLMStreaming; the JSON-repair retry stays on callLLM. Total
    // remains TWO calls, just split across the two wrappers.
    const callClaudeCount = (RUN_GEN_BODY.match(/callClaude\(/g) ?? []).length
    expect(callClaudeCount).toBe(0)
    const callLLMCount = (RUN_GEN_BODY.match(/\bcallLLM\(/g) ?? []).length
    const callLLMStreamingCount = (RUN_GEN_BODY.match(/\bcallLLMStreaming\(/g) ?? []).length
    expect(callLLMCount + callLLMStreamingCount).toBe(2)
    // Primary uses streaming (B1 pin above), retry uses non-streaming.
    expect(callLLMStreamingCount).toBe(1)
    expect(callLLMCount).toBe(1)
  })
})

describe('[generateMappings] C2 — per-batch user message includes source/target/other-sources blocks', () => {
  it('passes sourceSection + targetSection + otherSourcesBlock to buildMappingUserMessage', () => {
    // The per-batch message construction passes a single source table
    // section, the full target schema, and an `<other_source_tables>`
    // block enumerating the OTHER source tables in this generation.
    expect(RUN_GEN_BODY).toContain('buildMappingUserMessage({')
    const callSlice = sliceBetween(
      RUN_GEN_BODY,
      'const batchUserMessage = buildMappingUserMessage({',
      '})',
    )
    expect(callSlice).toContain('sourceSection')
    expect(callSlice).toContain('targetSection')
    expect(callSlice).toContain('docBlock')
    expect(callSlice).toContain('otherSourcesBlock')
  })

  it('builds the otherSourcesBlock as an XML-style <other_source_tables> wrapper', () => {
    expect(RUN_GEN_BODY).toContain('<other_source_tables>')
    expect(RUN_GEN_BODY).toContain('</other_source_tables>')
  })

  it('otherSourcesBlock excludes the current source table from the listing', () => {
    // The filter that keeps the current table out of "other sources".
    // Pin: `.filter((st) => st.id !== currentSourceRow?.id)`.
    expect(RUN_GEN_BODY).toMatch(
      /\.filter\(\s*\(st\)\s*=>\s*st\.id\s*!==\s*currentSourceRow\?\.id\s*\)/,
    )
  })

  it('user-message builder concatenates source/target/doc/intelligence/other-sources sections in fixed order', () => {
    // Pin the assembly order in buildMappingUserMessage. The order
    // affects how Claude reads the request: schema first, docs next,
    // intelligence context next, sibling-sources block last (closest
    // to the JSON request). Anchor on template-literal interpolations
    // — not bare identifier names — because identifiers also appear
    // in the function signature and destructure above the template
    // body.
    const indexOfSource = USER_MESSAGE_BUILDER.indexOf('${sourceSection}')
    const indexOfTarget = USER_MESSAGE_BUILDER.indexOf('${targetSection}')
    const indexOfDoc = USER_MESSAGE_BUILDER.indexOf('${docBlock}')
    const indexOfIntel = USER_MESSAGE_BUILDER.indexOf("${intelligenceCtx ?")
    const indexOfOther = USER_MESSAGE_BUILDER.indexOf("${otherSourcesBlock ?")

    expect(indexOfSource).toBeGreaterThan(0)
    expect(indexOfTarget).toBeGreaterThan(indexOfSource)
    expect(indexOfDoc).toBeGreaterThan(indexOfTarget)
    expect(indexOfIntel).toBeGreaterThan(indexOfDoc)
    expect(indexOfOther).toBeGreaterThan(indexOfIntel)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group D — JSON parse + retry behavior
// ─────────────────────────────────────────────────────────────────────

describe('[generateMappings] D1 — first-call success path', () => {
  it('parses the response with parseClaudeJSON before any retry consideration', () => {
    // The primary parse happens in the inner try; only on its catch
    // do we enter the retry block. Pinning the inner-try pattern here.
    expect(RUN_GEN_BODY).toContain('const batchParsed = parseClaudeJSON(batchRaw)')
  })

  it('appends the parsed table_mappings array to the cross-batch accumulator', () => {
    expect(RUN_GEN_BODY).toMatch(
      /allTableMappings\.push\(\.\.\.\(batchParsed\.table_mappings\s*\?\?\s*\[\]\)\)/,
    )
  })
})

describe('[generateMappings] D2 — first-call failure → JSON-repair retry', () => {
  it('uses the verbatim JSON-repair system prompt on retry', () => {
    // The retry uses a different system prompt — it asks Claude to
    // act as a "JSON repair tool" rather than the full mapping
    // expert. This is critical: the retry context is much smaller
    // because the input is just the malformed JSON.
    expect(RUN_GEN_BODY).toContain(
      "'You are a JSON repair tool. Return ONLY valid JSON, nothing else.'",
    )
  })

  it('forwards the malformed batchRaw into the retry user message', () => {
    expect(RUN_GEN_BODY).toContain('The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:')
    // The malformed string is interpolated into the user message.
    expect(RUN_GEN_BODY).toMatch(/Fix it and return ONLY the corrected JSON:[\s\S]{0,80}\$\{batchRaw\}/)
  })

  it('parses the retry response with the same parseClaudeJSON helper', () => {
    // Post-PR-6: callLLM returns a result object with `.text`, so the
    // parsed retry input is now `retryResult.text` (was `retryRaw`
    // pre-PR-6 when callClaude returned a raw string).
    expect(RUN_GEN_BODY).toContain('parseClaudeJSON(retryResult.text)')
  })
})

describe('[generateMappings] D3 — both calls fail → continue to next source table (non-fatal)', () => {
  it('the retry catch block logs and falls through (no early return)', () => {
    // After the retry catch, control falls through the for loop
    // iteration. There is NO `return { success: false ... }` inside
    // the catch — that would abort the entire generation on a single
    // batch failure, which is not the legacy behavior.
    //
    // Indentation note: post-PR-4 the orchestrator is at top level
    // in the engine (no `guardWrites` wrapping), so the retry catch
    // block's closing braces are 2 spaces shallower than they were
    // in the legacy. End marker pinned at: `}` (close inner catch
    // at 8-space indent) + newline + 6-space `}` (close outer catch)
    // + newline + 4-space `}` (close for-loop).
    const retryFailureSlice = sliceBetween(
      RUN_GEN_BODY,
      'Failed to parse mappings for source table',
      '}\n      }\n    }',
    )
    expect(retryFailureSlice).not.toContain('return {')
  })
})

describe('[generateMappings] D4 — parseClaudeJSON: fence stripping + truncation guard', () => {
  it('strips ```json fences before parsing', () => {
    expect(PARSE_JSON_BODY).toMatch(/cleaned\.startsWith\(['"]\`{3}['"]\)/)
    expect(PARSE_JSON_BODY).toMatch(/replace\(\/\^\`{3}\(\?:json\)\?/)
  })

  it('validates table_mappings array shape after JSON.parse', () => {
    expect(PARSE_JSON_BODY).toContain('!parsed.table_mappings')
    expect(PARSE_JSON_BODY).toContain('Array.isArray(parsed.table_mappings)')
    expect(PARSE_JSON_BODY).toContain('Invalid response: missing table_mappings array')
  })

  it('logs a truncation hint when response is long and missing terminal brace/bracket', () => {
    // Pinning the heuristic: "long response" = >500 chars; "looks
    // truncated" = does not end with `}` or `]`. A future refactor
    // that loosens this heuristic should be conscious; the diagnostic
    // message has saved real debugging time.
    expect(PARSE_JSON_BODY).toContain('cleaned.length > 500')
    expect(PARSE_JSON_BODY).toMatch(/!trimmed\.endsWith\(['"]\}['"]\)/)
    expect(PARSE_JSON_BODY).toMatch(/!trimmed\.endsWith\(['"]\]['"]\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group E — Many-to-one collision collapse
// ─────────────────────────────────────────────────────────────────────
//
// This is the highest-leverage extraction target for PR 4. The
// collapse logic protects the `UNIQUE (project_id, target_field_id)`
// constraint on `target_field_mappings`: if Claude emits two field
// mappings to the same target, the second is folded into the first as
// a contributor and combinationType is forced to 'concat_space'.

describe('[generateMappings] E1 — collision collapse uses byTarget Map keyed by target_field_id', () => {
  it('declares a `byTarget` Map<string, CollapsedEntry> in persistClaudeFieldMappingsForTM', () => {
    expect(PERSIST_BODY).toMatch(/const\s+byTarget\s*=\s*new Map<string,\s*CollapsedEntry>/)
  })

  it('keys the map by target field id (tgtField.id), not by source field id', () => {
    expect(PERSIST_BODY).toContain('byTarget.set(tgtField.id, {')
    expect(PERSIST_BODY).toContain('byTarget.get(tgtField.id)')
  })
})

describe('[generateMappings] E2 — second hit on same target appends a contributor (not overwrites)', () => {
  it('the existing-entry branch pushes onto contributorSourceIds instead of replacing the entry', () => {
    // The "second row for same target" branch must MUTATE the
    // existing entry, not replace it. A refactor that changes
    // `byTarget.set(...)` instead of `existing.contributorSourceIds.push(...)`
    // would silently drop the primary on collision.
    expect(PERSIST_BODY).toContain('Second row for same target')
    expect(PERSIST_BODY).toMatch(/existing\.contributorSourceIds\.push\(srcField\.id\)/)
  })

  it('the contributor-append branch is gated on srcField.id !== existing.primarySourceId', () => {
    // Defensive: a duplicate of the primary itself must not be added
    // as a contributor. Pin the gate.
    expect(PERSIST_BODY).toMatch(
      /if\s*\(\s*srcField\.id\s*!==\s*existing\.primarySourceId\s*\)/,
    )
  })
})

describe('[generateMappings] E3 — collision forces combinationType to concat_space', () => {
  it("the existing-entry branch sets existing.combinationType = 'concat_space'", () => {
    // This is the load-bearing line. Without it, two mappings to the
    // same target would persist with the FIRST entry's combinationType
    // (which would be 'single' if Claude emitted one_to_one) and the
    // RPC would receive a single TFM with combinationType='single' but
    // two sources — a contradictory shape.
    expect(PERSIST_BODY).toMatch(
      /existing\.combinationType\s*=\s*['"]concat_space['"]/,
    )
  })
})

describe('[generateMappings] E4 — first-hit many-to-one path also collects contributing_source_fields', () => {
  it('first-hit branch collects fm.contributing_source_fields when mapping_type === "many_to_one"', () => {
    // The collapse handles two sources of contributors:
    //   (a) Claude emitted explicit `contributing_source_fields` on a
    //       single field_mapping with mapping_type='many_to_one'.
    //   (b) Claude emitted N separate field_mappings to the same target.
    // (a) is pinned here; (b) is pinned in E2/E3.
    expect(PERSIST_BODY).toMatch(
      /mappingType\s*===\s*['"]many_to_one['"]\s*&&\s*fm\.contributing_source_fields\?\.length/,
    )
    expect(PERSIST_BODY).toContain('for (const name of fm.contributing_source_fields)')
    // De-duplicate against the primary: don't add the primary as its
    // own contributor.
    expect(PERSIST_BODY).toMatch(
      /c\.id\s*!==\s*srcField\.id/,
    )
  })

  it('one_to_one mappings get combinationType="single" by default', () => {
    expect(PERSIST_BODY).toMatch(
      /mappingType\s*===\s*['"]many_to_one['"]\s*\?\s*['"]concat_space['"]\s*:\s*['"]single['"]/,
    )
  })
})

describe('[generateMappings] E5 — non-collision path: one mapping per target → no collapse', () => {
  it('first-hit path always emits a fresh CollapsedEntry (the !existing branch)', () => {
    // Pin the structure: there is an `if (!existing) { byTarget.set(...) }`
    // block; collisions go to the `else` branch.
    const collapseSlice = sliceBetween(
      PERSIST_BODY,
      'const existing = byTarget.get(tgtField.id)',
      '} else {',
    )
    expect(collapseSlice).toContain('byTarget.set(tgtField.id, {')
    expect(collapseSlice).toContain('contributorSourceIds: contributors,')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group F — Persistence shape
// ─────────────────────────────────────────────────────────────────────

describe('[generateMappings] F1 — dq_create_target_field_mapping RPC arg shape', () => {
  it('calls supabase.rpc("dq_create_target_field_mapping", …) with the five expected keys', () => {
    expect(PERSIST_BODY).toContain("supabase.rpc('dq_create_target_field_mapping'")
    expect(PERSIST_BODY).toContain('p_project_id: projectId,')
    expect(PERSIST_BODY).toContain('p_target_field_id: entry.targetFieldId,')
    expect(PERSIST_BODY).toContain('p_sources: sources,')
    expect(PERSIST_BODY).toContain('p_combination: {')
    // PR Ω.1 — p_table_mapping_id is the partition binding (NOT NULL post-107).
    expect(PERSIST_BODY).toContain('p_table_mapping_id: tableMappingId,')
  })

  it('p_combination carries type and ai_reasoning, no other keys', () => {
    const combinationSlice = sliceBetween(
      PERSIST_BODY,
      'p_combination: {',
      '}',
    )
    expect(combinationSlice).toContain('type: entry.combinationType,')
    expect(combinationSlice).toContain('ai_reasoning: entry.reasoning,')
    // Pin the absence of other keys — adding new keys to p_combination
    // is a real schema change that needs explicit review.
    expect(combinationSlice).not.toMatch(/\bsource_field_id\s*:/)
    expect(combinationSlice).not.toMatch(/\bordinal\s*:/)
  })
})

describe('[generateMappings] F2 — primary source ordinal=0 and contributors ordinals 1..N', () => {
  it('primary source object is built with ordinal: 0', () => {
    // The first sources[] entry is the primary (ordinal=0). Pin it.
    const sourcesSlice = sliceBetween(
      PERSIST_BODY,
      'const sources = [',
      '...entry.contributorSourceIds.map',
    )
    expect(sourcesSlice).toContain('source_field_id: entry.primarySourceId,')
    expect(sourcesSlice).toContain('ordinal: 0,')
  })

  it('contributor sources receive ordinal: i + 1 (so first contributor is 1, second is 2, …)', () => {
    // Pin the ordinal generator so a refactor that drops the +1 is
    // caught.
    expect(PERSIST_BODY).toMatch(
      /contributorSourceIds\.map\(\(cid,\s*i\)\s*=>\s*\(\{[\s\S]+?ordinal:\s*i\s*\+\s*1,/,
    )
  })
})

describe('[generateMappings] F3 — confidence + ai_reasoning persist on each mapping_source row', () => {
  it('primary source row carries confidence and ai_reasoning', () => {
    const sourcesSlice = sliceBetween(
      PERSIST_BODY,
      'const sources = [',
      '...entry.contributorSourceIds',
    )
    expect(sourcesSlice).toContain('confidence: entry.confidence,')
    expect(sourcesSlice).toContain('ai_reasoning: entry.reasoning,')
  })

  it('contributor source rows also carry confidence (same as primary) and ai_reasoning', () => {
    const contributorSlice = sliceBetween(
      PERSIST_BODY,
      'contributorSourceIds.map((cid, i) => ({',
      '})),',
    )
    expect(contributorSlice).toContain('confidence: entry.confidence,')
    expect(contributorSlice).toContain('ai_reasoning:')
    // Contributors carry the synthetic "Contributing source for many-to-one"
    // reasoning, not the primary's reasoning. Pin that contract.
    expect(contributorSlice).toContain('Contributing source for many-to-one.')
  })
})

describe('[generateMappings] F4 — TFM-level confidence rollup is left to the DB layer', () => {
  it('the RPC payload does NOT pre-compute a TFM-level confidence', () => {
    // The DB-side trigger (or recomputeTableMappingStatus) computes
    // the TFM rollup from per-source confidences. The action layer
    // must not pre-compute it on the way in. Pin via absence of any
    // top-level `confidence:` key on the RPC arguments object.
    const rpcCallSlice = sliceBetween(
      PERSIST_BODY,
      "supabase.rpc('dq_create_target_field_mapping'",
      '})',
    )
    // Top-level keys: p_project_id, p_target_field_id, p_sources,
    // p_combination, p_table_mapping_id only. No bare `confidence:` at
    // depth 1 of the RPC args object.
    const topLevelKeys = rpcCallSlice
      .split('\n')
      .filter((l) => /^\s{6}p_/.test(l))
      .map((l) => l.trim().split(':')[0])
    expect(topLevelKeys.sort()).toEqual([
      'p_combination',
      'p_project_id',
      'p_sources',
      'p_table_mapping_id',
      'p_target_field_id',
    ])
  })
})

describe('[generateMappings] F5 — table_mappings.insert precedes the per-target RPC fan-out', () => {
  it('table_mappings INSERT happens BEFORE persistClaudeFieldMappingsForTM is called', () => {
    // Indentation note: post-PR-4 the INSERT lives in
    // runMappingGeneration in the engine. The orchestrator is at top
    // level so the INSERT is at indent 8 (inside the for-of loop at 6),
    // not the 10-space indent it had in the legacy `guardWrites` body.
    const insertIdx = RUN_GEN_BODY.indexOf("from('table_mappings')\n        .insert({")
    const persistIdx = RUN_GEN_BODY.indexOf('persistClaudeFieldMappingsForTM({')
    expect(insertIdx).toBeGreaterThan(0)
    expect(persistIdx).toBeGreaterThan(insertIdx)
  })

  it('table_mappings.status is set to "needs_review" on insert (not auto-approved)', () => {
    expect(RUN_GEN_BODY).toContain("status: 'needs_review',")
  })
})

// ─────────────────────────────────────────────────────────────────────
// Group G — Error paths
// ─────────────────────────────────────────────────────────────────────

describe('[generateMappings] G1 — zero-stored fallthrough → INTERNAL error with name-mismatch hint', () => {
  it('returns errorCode: "INTERNAL" with the verbatim name-mismatch error string', () => {
    // The string is intentionally specific so users get a useful hint
    // when Claude returns mappings whose table names do not match the
    // schema. Pinning verbatim catches accidental reword that would
    // make the message vague.
    expect(RUN_GEN_BODY).toContain(
      'mapping suggestion(s) but none matched your table names',
    )
    // Pin the surrounding error-shape: `errorCode: 'INTERNAL'` is
    // present in the same return statement.
    const errorSlice = sliceBetween(
      RUN_GEN_BODY,
      'mapping suggestion(s) but none matched',
      '}',
    )
    expect(errorSlice).toContain("errorCode: 'INTERNAL'")
  })
})

describe('[generateMappings] G2 — individual Claude throw is non-fatal (per-batch)', () => {
  it('callClaude failure inside the batch loop falls through to `continue`, not `return`', () => {
    // Critical invariant: ONE source table failing should not abort
    // the entire generation. A refactor that changes `continue` to
    // `return` would surprise users who selected multiple source
    // tables.
    //
    // Indentation note: post-PR-4 the orchestrator is at top level
    // in the engine. The catch block's closing brace and the next
    // statement are at 6-space indent (one level shallower than the
    // legacy 8-space indent under `guardWrites`).
    //
    // PR 12 update: the catch block is now followed by the
    // `if (primaryResult.kind === 'toolUse')` discriminator branch
    // (rather than another `try {`); the marker tracks that.
    const claudeCatchSlice = sliceBetween(
      RUN_GEN_BODY,
      'Claude call failed for source table',
      "}\n\n      if (primaryResult.kind === 'toolUse')",
    )
    expect(claudeCatchSlice).toContain('continue')
    expect(claudeCatchSlice).not.toContain('return {')
  })
})

describe('[generateMappings] G3 — rate-limit returns errorCode: "VALIDATION" (legacy taxonomy)', () => {
  it('checkAIRateLimit failure returns errorCode "VALIDATION", not "RATE_LIMITED"', () => {
    // The legacy file uses 'VALIDATION' for rate-limit denial. The
    // redesign-side `suggestMappingForTarget` uses 'RATE_LIMITED'.
    // These taxonomies diverge by design — pin both files
    // independently so a "harmonization" refactor doesn't silently
    // change the legacy error code shipped to MappingContent.tsx.
    const rateLimitSlice = sliceBetween(
      GENERATE_BODY,
      'const rateLimit = checkAIRateLimit(',
      '}\n\n    if (!sourceTableIds.length',
    )
    expect(rateLimitSlice).toContain("errorCode: 'VALIDATION'")
    expect(rateLimitSlice).not.toContain("errorCode: 'RATE_LIMITED'")
  })
})

describe('[generateMappings] G4 — empty source/target arrays → VALIDATION', () => {
  it('rejects empty sourceTableIds or targetTableIds with errorCode "VALIDATION"', () => {
    expect(GENERATE_BODY).toMatch(
      /!sourceTableIds\.length\s*\|\|\s*!targetTableIds\.length/,
    )
    expect(GENERATE_BODY).toContain(
      "Select at least one source and one target table",
    )
  })
})

describe('[generateMappings] G5 — auth + permission gates fire before any AI work', () => {
  it('getUser → requireProjectPermission → guardWrites all precede runMappingGeneration', () => {
    // Post-PR-4: the wrapper has no `callClaude` directly; it
    // delegates to `runMappingGeneration` which does the AI work.
    // The "any expensive work" semantic is preserved: auth gates
    // must run before delegation.
    const getUserIdx = GENERATE_BODY.indexOf('supabase.auth.getUser')
    const permIdx = GENERATE_BODY.indexOf("requireProjectPermission(projectId, 'editor')")
    const guardIdx = GENERATE_BODY.indexOf('guardWrites(projectId,')
    const delegateIdx = GENERATE_BODY.indexOf('runMappingGeneration(')

    expect(getUserIdx).toBeGreaterThan(0)
    expect(permIdx).toBeGreaterThan(getUserIdx)
    expect(guardIdx).toBeGreaterThan(permIdx)
    expect(delegateIdx).toBeGreaterThan(guardIdx)
  })
})

describe('[generateMappings] G6 — existing-pair skip path: success, not error', () => {
  // The load-bearing distinction from G1: when zero TMs are stored
  // because EVERY suggested pair already exists, `generateMappings`
  // returns `{ success: true, generated: 0, skipped: M, message }` —
  // NOT the `INTERNAL` name-mismatch error. PR 4 must preserve this
  // taxonomy: "AI suggested but everything was a duplicate" is a
  // success state for the UI (it shows "go manage existing mappings"),
  // while "AI suggested but the names didn't match" is a hard failure.

  it('builds an existingPairSet from current table_mappings, scoped to projectId', () => {
    // The pre-loop fetch that powers de-duplication. Pin the table,
    // the columns, and the project filter — the set is the
    // determinant of the skip path.
    expect(GENERATE_BODY).toMatch(
      /from\(['"]table_mappings['"]\)\s*\.select\(['"]source_table_id,\s*target_table_id['"]\)\s*\.eq\(['"]project_id['"],\s*projectId\)/,
    )
    expect(GENERATE_BODY).toContain('const existingPairSet = new Set(')
  })

  it('skip-path inside the persistence loop: existingPairSet.has(pairKey) → skippedCount++; continue', () => {
    // The hot path: when a Claude-suggested (src, tgt) pair already
    // has a TM, increment skippedCount and continue to the next
    // suggestion — do NOT insert a duplicate TM, do NOT call
    // persistClaudeFieldMappingsForTM, do NOT short-circuit the loop.
    // Post-PR-4: the loop lives in the engine; the wrapper builds
    // and passes `existingPairSet` in.
    expect(RUN_GEN_BODY).toMatch(/const\s+pairKey\s*=\s*`\$\{srcTable\.id\}::\$\{tgtTable\.id\}`/)
    const skipSlice = sliceBetween(
      RUN_GEN_BODY,
      'if (existingPairSet.has(pairKey)) {',
      '}',
    )
    expect(skipSlice).toContain('skippedCount++')
    expect(skipSlice).toContain('continue')
    // Defensive: must NOT issue a return inside the skip branch (that
    // would abort the whole generation on the first duplicate).
    expect(skipSlice).not.toContain('return {')
  })

  it('zero stored + nonzero skipped → success: true with generated: 0 and skipped: M', () => {
    // The success-with-skips branch lives inside the
    // `if (storedCount === 0)` block in the engine, gated on
    // `skippedCount > 0`. Pin the verbatim return shape — this is
    // the contract the UI relies on to render the "all pairs already
    // mapped" message instead of an error toast.
    //
    // Indentation note: post-PR-4 the orchestrator is at top level,
    // so the next-block start marker `return { success: false,`
    // sits at 6-space indent (was 10 in legacy `guardWrites`).
    const allSkippedSlice = sliceBetween(
      RUN_GEN_BODY,
      'if (storedCount === 0) {',
      "return {\n        success: false,",
    )
    expect(allSkippedSlice).toContain('if (skippedCount > 0) {')
    expect(allSkippedSlice).toContain('success: true,')
    expect(allSkippedSlice).toContain('generated: 0,')
    expect(allSkippedSlice).toContain('skipped: skippedCount,')
    // Verbatim user-facing message — pinning catches accidental
    // reword. The UI is permitted to extract this string for tests.
    expect(allSkippedSlice).toContain(
      "message: 'All selected table pairs already have mappings. Go to the Mapping tab to manage them.'",
    )
  })

  it('all-skipped path is distinct from the zero-stored INTERNAL error (G1)', () => {
    // Structural invariant: the all-skipped block returns BEFORE
    // control reaches the name-mismatch error. A refactor that
    // unifies these paths (e.g., returns `success: false` for both)
    // would silently regress the UI taxonomy. Pin via lexical order:
    // the `success: true` branch's text appears before the
    // `success: false ... errorCode: 'INTERNAL'` branch.
    const successTrueIdx = RUN_GEN_BODY.indexOf(
      "message: 'All selected table pairs already have mappings.",
    )
    const internalErrorIdx = RUN_GEN_BODY.indexOf('but none matched your table names')
    expect(successTrueIdx).toBeGreaterThan(0)
    expect(internalErrorIdx).toBeGreaterThan(successTrueIdx)
  })

  it('mixed outcome (some stored, some skipped) → success: true with both counters', () => {
    // The terminal `return { success: true, generated, skipped, message? }`
    // outside the zero-stored guard — used when at least one TM was
    // actually inserted. Pin both counter keys and the conditional
    // message clause that surfaces "Skipped N pair(s) that already
    // have mappings" only when skippedCount > 0.
    expect(RUN_GEN_BODY).toMatch(/return\s*\{\s*success:\s*true,\s*generated:\s*storedCount,\s*skipped:\s*skippedCount,/)
    expect(RUN_GEN_BODY).toContain('Skipped ')
    expect(RUN_GEN_BODY).toContain(' that already have mappings.')
  })
})
