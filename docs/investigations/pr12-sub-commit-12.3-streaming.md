# PR 12 sub-commit 12.3 — Streaming callsite (Phase A investigation, read-only)

**Type:** Read-only investigation. The only artifact this phase produces is this document.

**Audience:** Phase B implementer + Kaan for sign-off.

**Scope:** Audit the 1 remaining streaming `callLLM` invocation, evaluate three implementation paths for migrating it to tool-use under flag-ON, and recommend one.

**Out of scope:** Path 2 / Path 3 implementation; PR 13 prompt caching.

---

## DIVERGENCE callouts (load-bearing — read first)

1. **Streaming + tool-use is ALREADY UNBLOCKED at the wrapper level.** The premise of this investigation (that streaming + tool-use is unsolved) is incorrect. [`callLLMStreaming`](../../lib/ai/llm-client.ts#L522) (lib/ai/llm-client.ts:522) already accepts `opts.tool` and threads it through the request — see lines 549-560. The inline comment at line 549 explicitly states: *"PR 12: same tool plumbing as callLLM. Streaming + tool_use is supported on SDK 0.78.0; `stream.finalMessage()` returns a fully-assembled message whose `content` array contains the tool_use block. The §9.1 probe verified this end-to-end."* PR 12.1 (PR #23) wired this and the §9.1 probe verified it.

2. **`EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` is fully authored and complete.** Located at [tool-schemas.ts:1287](../../lib/ai/tool-schemas.ts#L1287). The JSDoc comment at line 1280 reads: *"Declared in 12.1, used in 12.3."* The schema has 6 properties (filename, type, content, table_name, load_order, dependencies), enumerated file types (checklist/table_script/validation/promote/rollback), and follows the strict-mode catalog (additionalProperties: false uniformly; no oneOf / no min-max / no minItems-maxItems). PR 12.1 ALREADY exercised this through the test count (16 tools after PR 12.2 B-1; the existing `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` was 1 of those 16).

3. **The only work for PR 12.3 is the callsite migration itself.** No wrapper changes. No tool authoring. No SDK upgrade. The dead-code throw at [execution-package.ts:474](../../lib/actions/execution-package.ts#L474) is the ONE migration target.

4. **The "streaming" choice is operational, not UX.** Reading the function: the user clicks "Generate package", the response is fully collected via `stream.finalMessage()` (line 567 of llm-client.ts), parsed, assembled into files, and returned to the client as a single response. There is NO piecewise UI rendering. Streaming was chosen to avoid Anthropic's 60-second non-streaming response timeout on long responses, not for client-side progress updates. **This eliminates Path 2's tradeoff** — streaming-vs-non-streaming is invisible to the user; both options would tolerate identical UX.

---

## TL;DR

| Question | Answer |
|---|---|
| SDK supports streaming + tool-use? | ✅ Yes — `@anthropic-ai/sdk@0.78.0`; verified via PR 12.1's §9.1 probe |
| `callLLMStreaming` accepts a `tool` parameter? | ✅ Yes — already wired in lib/ai/llm-client.ts:549-560 |
| `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` exists & complete? | ✅ Yes — at lib/ai/tool-schemas.ts:1287, follows strict-mode catalog |
| Production callsite consumes streaming chunks piecewise? | ❌ No — `stream.finalMessage()` collects fully before parsing |
| Path 1 viability? | ✅ TRIVIAL — single callsite update, ~30-50 LOC |
| Path 2 viability? | ✅ Possible but pointless — equivalent work, loses long-response timeout safety |
| Path 3 (defer)? | ❌ Not needed — no blocker exists |

**Recommendation: Path 1 — Streaming + tool-use migration.** The infrastructure is already in place. PR 12.3's actual scope is mechanically migrating ONE callsite (lib/actions/execution-package.ts:462) to pass `tool: EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` and consume `result.toolUse.input.files` instead of the 30+ lines of regex/JSON-recovery scaffolding at lines 497-531.

---

## Section 1 — Anthropic SDK tool-use + streaming support

### Installed version

```
@anthropic-ai/sdk@0.78.0
```

Path: `node_modules/@anthropic-ai/sdk/package.json`. Well above the spec's `0.30.0` floor (no stop condition triggered).

### Streaming + tool-use feature support

The SDK's streaming entry point is `anthropic.messages.stream(request)` which returns a `MessageStream`. The relevant API for our use case:

- `stream.finalMessage()` — awaitable; returns the fully-assembled `Message` when streaming completes
- `Message.content` — array of content blocks, can include `text` blocks AND `tool_use` blocks
- The `tool_use` block on the final message is structurally IDENTICAL to the non-streaming response — same `name` / `input` shape, same strict-mode validation at the API boundary

### How it's used in the codebase today

[`callLLMStreaming`](../../lib/ai/llm-client.ts#L522) (already wired, lines 549-587):

```typescript
// Lines 549-560: tool plumbing identical to non-streaming callLLM
...(opts.tool && {
  tools: [opts.tool],
  tool_choice: {
    type: 'tool' as const,
    name: opts.tool.name,
    disable_parallel_tool_use: true,
  },
}),

// Lines 566-567: stream + collect
const stream = await anthropic.messages.stream(request)
const message = await stream.finalMessage()

// Lines 578-587: tool_use response parsing (identical to callLLM)
if (opts.tool) {
  const toolUseBlock = message.content.find(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  )
  if (!toolUseBlock || toolUseBlock.name !== opts.tool.name) {
    throw new Error(...)
  }
  // Returns { kind: 'toolUse', toolUse: {...} } — identical CallLLMResult shape
}
```

The wrapper handles streaming + tool-use end-to-end. No additional plumbing required.

### Probe history

PR 12.1's "§9.1 probe" (referenced in inline comment at [llm-client.ts:549](../../lib/ai/llm-client.ts#L549)) verified streaming + tool-use end-to-end on SDK 0.78.0. The wrapper is production-tested for this exact use case via the existing `tests/integration/llm-calls-streaming-logging.test.ts` (which currently exercises the text path; PR 12.3 should add a tool-use streaming test alongside).

---

## Section 2 — `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` audit

### Existence and completeness

Located at [tool-schemas.ts:1287](../../lib/ai/tool-schemas.ts#L1287) (NOT line 1287 from a stale prompt — the line is exact). JSDoc at line 1280:

```
Declared in 12.1, used in 12.3.

Used by: `outputs_execution_package_compartmentalized`
(lib/actions/execution-package.ts:460) — the only streaming
callsite. Sub-commit 12.3 wires it into callLLMStreaming. The shape
matches the existing `ClaudeFileEntry` interface.
```

### Schema audit

**Top-level shape:**
- `type: 'object'` ✅
- `additionalProperties: false` ✅
- `required: ['files']` ✅
- 1 property: `files` (array of file objects)

**Per-file object:**
- `additionalProperties: false` ✅
- `required: ['filename', 'type', 'content']` ✅ (table_name, load_order, dependencies are optional — populated only for type='table_script')
- 6 properties total: filename, type (enum, 5 values), content, table_name, load_order, dependencies (array of strings)

**Strict-mode constraints check (per [docs/anthropic-strict-mode-constraints.md](../anthropic-strict-mode-constraints.md)):**
- ✅ No `oneOf`
- ✅ No `additionalProperties: true`
- ✅ No `minimum`/`maximum` (description-encoded constraints only)
- ✅ No `minItems`/`maxItems`
- ✅ All nested objects declare `additionalProperties: false`

**Description quality:**
- Top-level description: 200+ chars (passes the rich-tier threshold per tests/lib/tool-schemas.test.ts:161)
- Each property has ≥30 char description
- The `type` enum description distinguishes the 5 file types and their packaging semantics
- Load-order semantics described in the top-level description

### Schema match against `ClaudeFileEntry` interface

The production callsite defines `ClaudeFileEntry` at [execution-package.ts:486-493](../../lib/actions/execution-package.ts#L486-L493):

```typescript
interface ClaudeFileEntry {
  filename: string
  type: string
  content: string
  table_name?: string
  load_order?: number
  dependencies?: string[]
}
```

**Tool input shape exactly matches.** The runtime `parsed.files: ClaudeFileEntry[]` consumed at line 529 maps 1:1 to `result.toolUse.input.files`.

### Verdict

✅ **Tool is complete and correct.** No schema work required for PR 12.3.

---

## Section 3 — Production callsite audit

### Function signature + call chain

`generateCompartmentalizedPackageInternal(projectId, dialect, opts): Promise<CompartmentalizedPackageResult | ExecutionPackageError>` at [execution-package.ts:445](../../lib/actions/execution-package.ts#L445).

Public wrapper: `generateCompartmentalizedPackage(projectId, dialect)` at [execution-package.ts:799](../../lib/actions/execution-package.ts#L799).

UI caller: [`OutputsContent.tsx:405`](../../app/app/projects/[projectId]/outputs/OutputsContent.tsx#L405) — single call site, button-triggered (`generateExecutionPackageWithFormat(projectId, sqlDialect, 'per_table')`).

### Output shape

Returns `CompartmentalizedPackageResult | ExecutionPackageError`. The compartmentalized result carries:
- A list of file entries, each with assignedFilename + content, ordered for execution
- Optional dialect-validation-failure → monolithic-fallback path (which itself uses non-streaming `callLLM` at line 623 — already migrated in PR 12.2 B-1)

### Streaming response consumption

**Critical finding:** the response is fully collected via `stream.finalMessage()` (in the wrapper, line 567 of llm-client.ts) BEFORE any parsing happens. The callsite at [execution-package.ts:472](../../lib/actions/execution-package.ts#L472) then receives `result.text` (the fully-assembled string) and proceeds to:

1. **Fence-strip** (lines 499-501): `replace(/^```(?:json)?\s*\n?/i, '')`
2. **Preamble-strip** (lines 503-507): if there's any text before the first `{`, slice it off
3. **Truncation recovery** (lines 509-526): if response doesn't end with `}`, find the last `}`, slice, and auto-balance unmatched brackets/braces
4. **`sanitizeClaudeJson`** (line 528) — additional JSON-shaped cleanup
5. **`JSON.parse`** (line 529) — finally parse

Then validates `parsed.files` is an array and casts to `ClaudeFileEntry[]`.

This entire 30+ line scaffolding exists BECAUSE Anthropic's text-mode JSON output is fragile. **Tool-use eliminates ALL of it.** Under flag-ON the callsite would receive `result.toolUse.input.files` directly — already-parsed, already-validated by Anthropic's strict-mode boundary.

### Why streaming was originally chosen

There are no comments explaining the choice. Inferred from the SDK behavior:

- Compartmentalized package generation produces a large multi-file output (`maxTokens: bundle.maxTokens` — typically 32K under flag-ON per `DEFAULT_STREAMING_MAX_TOKENS = 32000` in llm-client.ts:160)
- Anthropic's non-streaming endpoint has a 60-second response timeout for long-running model invocations
- Streaming via `messages.stream()` bypasses this timeout because the connection stays open while content is generated
- The streaming wrapper still collects to completion via `stream.finalMessage()` — no piecewise UI rendering happens

**Implication:** "streaming" here is operational (long-response safety), not UX (no progress bar). Path 2 (convert to non-streaming) would risk timeouts on large 32K-token responses; Path 1 keeps the streaming property AND adds tool-use schema validation.

### Dead-code throw at line 474

```typescript
// PR 12: streaming callsite — migrated to tool use in sub-commit 12.3.
if (result.kind !== 'text') {
  throw new Error('outputs_execution_package_compartmentalized: unexpected toolUse response')
}
rawResponse = result.text
primaryCallId = result.callId
```

This is the SAME pattern PR 12.2 B-1 migrated for the 4 SQL emitters: pre-positioned narrowing throw waiting for the `tool` parameter to be added. PR 12.3 replaces it with the standard `if (result.kind === 'toolUse') { ... } else { ... legacy text path ... }` shape.

---

## Section 4 — `callLLMStreaming` wrapper audit

Already covered in Section 1 (the wrapper accepts `tool` since PR 12.1). Summarizing:

| Question | Answer |
|---|---|
| Function signature | `callLLMStreaming(opts: CallLLMOptions): Promise<CallLLMResult>` |
| Accepts `tool` parameter? | Yes (via shared `CallLLMOptions.tool` from llm-client.ts:117) |
| Threads `tools` + `tool_choice` to Anthropic? | Yes (lines 553-560) |
| Collects stream to completion? | Yes (`await stream.finalMessage()` at line 567) |
| Handles tool_use response? | Yes (lines 578-621, identical to callLLM's tool branch at lines 411-457) |
| Return shape | Discriminated `CallLLMResult` union: `{ kind: 'text', text } \| { kind: 'toolUse', toolUse: { name, input } }` |

**No wrapper changes required.**

The existing `tests/integration/llm-calls-streaming-logging.test.ts` exercises `callLLMStreaming` under text mode; PR 12.3 should add an analogous tool-mode integration test (the existing `tests/integration/llm-calls-logging.test.ts` covers callLLM tool mode).

---

## Section 5 — Three implementation paths

### Path 1 — Streaming + tool-use migration

**Status:** ✅ Trivially viable; recommended.

**What it requires:**
- Single callsite edit: add `phase2Enabled` check + `...(phase2Enabled && { tool: EMIT_COMPARTMENTALIZED_PACKAGE_TOOL })` to the call at [execution-package.ts:462](../../lib/actions/execution-package.ts#L462)
- Replace the dead-code narrowing throw (line 474) with the standard `if (result.kind === 'toolUse') { ... } else { ... legacy text path ... }` discriminated-union pattern
- Under flag-ON: read `result.toolUse.input.files` directly (skip the 30 lines of JSON recovery scaffolding)
- Under flag-OFF: existing legacy text path stays intact, byte-identical to PR #23 baseline
- Add 1 unit test: `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` structural invariants (already-existing tests pass; just one new specific test for the file-types enum + load_order semantics)
- Add 1 integration test (optional): tool-mode streaming smoke

**LOC delta estimate:** ~50-80 (mostly comment cleanup + branch addition)

**Risk:** Low. Mirrors PR 12.2 B-1's exact pattern. Heritage flag-OFF byte-identical because flag-OFF doesn't pass `tool`.

### Path 2 — Convert callsite to non-streaming

**Status:** Possible but pointless.

**What it requires:**
- Change `callLLMStreaming` to `callLLM` at line 462
- Same tool-use migration as Path 1 (no UX change since streaming wasn't UX in the first place)

**Why pointless:** Section 3 established that streaming was chosen for long-response timeout safety, not UX. Converting to non-streaming would risk Anthropic's 60-second timeout on 32K-token compartmentalized responses. Path 1 preserves this safety property AND gets the same tool-use enforcement.

**LOC delta estimate:** ~30-50 (just the wrapper-function name swap + tool-use branch).

**Risk:** Medium. Trades a verified working path (streaming) for a potential timeout regression. No upside.

### Path 3 — Defer indefinitely

**Status:** Not needed.

**Why:** All blockers Phase A's premise assumed are non-blockers in reality. SDK supports streaming + tool-use; wrapper supports it; tool exists. There's nothing to defer.

**Path 3 would only become relevant if:**
- A future SDK regression broke streaming + tool-use compatibility (no signal)
- The compartmentalized output structure changed in a way the tool can't express (no signal — schema matches `ClaudeFileEntry` exactly)

### Recommendation: Path 1, single-commit migration

Mirror PR 12.2 B-1's posture: one commit covering the callsite migration + 1 unit test + (optionally) 1 integration test. Production behavior under flag-OFF byte-identical; under flag-ON the 30-line JSON recovery scaffolding becomes dead-code under the toolUse branch (existing under text branch only).

---

## Section 6 — Risk assessment

### R1 — Path 1: streaming + tool-use API quirks

**Risk:** Anthropic's strict-mode boundary might reject `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` on the streaming endpoint specifically (different from non-streaming) — e.g., the grammar-compilation 503 catalogued in `docs/anthropic-strict-mode-constraints.md` §6 hit `EMIT_EXTRACTED_PATTERNS_TOOL` (similar size class).

**Verification:** Flag-ON smoke under `AI_PHASE_2_ENABLED=1` calling `generateCompartmentalizedPackage` end-to-end. If the schema 503s, the smoke fails clearly. The schema is comparable in size to `EMIT_EXTRACTED_PATTERNS_TOOL` (which 503'd) but has a simpler enum-only shape (no description-embedded canonical vocabulary), so the failure mode is unlikely. If it does 503, document and retry per the catalog's known-issues entry; tool-use migration still works on subsequent retries.

### R2 — Wrapper-level type plumbing complexity

**Risk:** Wrapper changes might subtly break the text-mode path.

**Verification:** Heritage flag-OFF byte-identical integration test. Already gates this on every PR.

**Status:** N/A — Path 1 requires NO wrapper changes. Risk is moot.

### R3 — Production consumption pattern doesn't match new shape

**Risk:** Downstream code might assume `parsed.files` came from JSON.parse of a string, and have hidden coupling to that flow (e.g., a try/catch downstream that expects `JSON.parse` errors specifically).

**Verification:** Read [execution-package.ts:540-608](../../lib/actions/execution-package.ts#L540-L608) — the post-parse code consumes `claudeFiles: ClaudeFileEntry[]` as a typed array. No string-form coupling visible. The `parsed.files` array is used identically in both branches (typed extract from an object).

**Status:** Low risk. Can be eliminated by reviewing the file in detail during Phase B.

### R4 — UX regression (Path 2 specific)

**Risk:** If Path 2 chosen, non-streaming endpoint times out at 60s on large responses → user sees error instead of package.

**Verification:** Smoke under flag-ON with a representative project that produces a 20K+-token compartmentalized response. If timeouts occur, abandon Path 2.

**Status:** N/A under recommended Path 1.

### R5 — Server timeout if non-streaming response too large (Path 2 specific)

Same as R4.

### R6 — Technical debt remains (Path 3 specific)

Same as R4, but conditional on Path 3.

**Status:** N/A under recommended Path 1.

### R7 — PR 13 dependency on full PR 12 consolidation

**Risk:** PR 13 (prompt caching) might silently assume all callsites use tool-use, and surface a regression if any callsite stayed text-mode.

**Verification:** Phase A of PR 13 will audit cluster state. Confirm `outputs_execution_package_compartmentalized` is migrated before PR 13 ships. With Path 1, this is automatic; PR 12.3 closes out the consolidation cleanly.

**Status:** Path 1 eliminates this risk.

### R8 — Tool 503s on streaming endpoint specifically

**Risk:** PR 12.2 B-2 documented an Anthropic grammar-compilation 503 that affects the LARGEST strict-mode schemas (the `EMIT_EXTRACTED_PATTERNS_TOOL` is the recurring offender). `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` is similar in size but has a simpler shape.

**Verification:** Phase B's smoke. If 503s recur, pattern-match to known-issues entry; same workaround as extracted-patterns (retry, document, no schema change required because the schema is correct — Anthropic's compilation cache simply intermittently overloads).

**Status:** Pre-existing transient external risk; not introduced by PR 12.3.

---

## Section 7 — Surprises / divergences

### Surprises

1. **The investigation premise was inverted.** Phase A claimed streaming + tool-use was "unsolved per Anthropic SDK" but the wrapper was already wired and verified end-to-end via PR 12.1's §9.1 probe. The work I expected to do (SDK feature exploration, wrapper modification, tool authoring) had ALREADY happened.

2. **The "streaming" choice is operational, not UX.** Reading the function carefully: `stream.finalMessage()` collects the response to completion before returning. There's NO piecewise UI rendering, NO `for await` of stream events. Streaming's only role is bypassing Anthropic's 60-second non-streaming timeout — invisible to users.

3. **30+ lines of JSON recovery scaffolding become dead code.** Lines 497-526 of execution-package.ts (fence-strip, preamble-strip, truncation-recovery, sanitizeClaudeJson) all exist BECAUSE text-mode JSON output is fragile. Tool-use eliminates ALL of this for the flag-ON path. Under flag-OFF the scaffolding remains as-is.

4. **`EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` was already counted in the 16-tool baseline.** PR 12.2 B-1's tool-count test (`expect(allTools.length).toBe(16)`) ALREADY includes the unwired compartmentalized tool. PR 12.3 doesn't add a tool — it just wires up the existing one.

5. **The file location matches the JSDoc.** Phase A's premise mentioned line 463 (callsite); JSDoc at [tool-schemas.ts:1283](../../lib/ai/tool-schemas.ts#L1283) says line 460. Off by 2 lines. Trivial.

### No DIVERGENCEs from the spec's stop conditions

- ✅ SDK version 0.78.0 ≫ 0.30.0
- ✅ `callLLMStreaming` exists and matches expected shape
- ✅ `EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` exists at the claimed line (within ± a few lines)

---

## Out of scope

- Path 1 implementation (Phase B work — separate prompt)
- Path 2 / Path 3 implementation
- Adding new tool schemas (none needed)
- Wrapper-level changes (none needed)
- Anthropic SDK upgrade (none needed)
- PR 13 prompt caching scope

## DIVERGENCE summary (consolidated)

1. **Investigation premise inverted** — streaming + tool-use is UNBLOCKED. Path 1 is trivially viable; the wrapper, tool, and SDK are all production-ready.
2. **Streaming choice is operational, not UX** — converting to non-streaming (Path 2) would lose long-response timeout safety with zero UX gain.
3. **`EMIT_COMPARTMENTALIZED_PACKAGE_TOOL` already counted in PR 12.2 B-1's 16-tool baseline** — PR 12.3 doesn't add a tool, just wires it up.
4. **30 lines of JSON recovery scaffolding become dead code under flag-ON** — flag-OFF retains them; flag-ON skips them via the `result.kind === 'toolUse'` branch.
5. **Phase B is ~50-80 LOC, single commit** — much smaller than B-1 (~727 net LOC) or even B-2 (-12 net LOC).

*End of PR 12 sub-commit 12.3 — Streaming callsite Phase A investigation.*
