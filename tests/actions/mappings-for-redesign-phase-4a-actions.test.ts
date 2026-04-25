// @vitest-environment node
//
// Phase 4a-1 — source-level invariant tests for the redesign-side
// `createFieldMapping` and `suggestMappingForTarget` wrappers.
//
// Same rationale as `mappings-for-redesign-actions.test.ts` (Gap 9):
// the wrappers touch Supabase auth, permission checks, the maintenance
// guard, the `dq_create_target_field_mapping` RPC, the Anthropic
// client, and the activity log. Spinning up a full mocking harness for
// every codepath is expensive; instead we read the source file and
// assert the call-site shape locks the founder-locked decisions in
// place.
//
// Founder-locked decisions captured here as regression guards:
//   1. AUTO-APPROVE = NO. New TFMs created via the wrapper rely on the
//      RPC's hardcoded `'needs_review'` insert. The wrapper must NOT
//      issue a follow-up UPDATE flipping status to 'approved'.
//   2. EXISTING-TFM COLLISION returns the user-facing copy "This target
//      field was mapped while you were editing. Refresh to see the
//      current state." with errorCode 'VALIDATION'.
//   3. AI RATIONALE persists on TFM.ai_reasoning when the user accepts
//      an AI suggestion (input.aiReasoning threads through to the RPC's
//      p_combination.ai_reasoning).
//   4. CROSS-TABLE INPUT in 4a-1 returns 'CROSS_TABLE_NOT_YET_SUPPORTED'
//      with the deferral copy. 'CROSS_TABLE_AMBIGUOUS' is reserved on
//      the union for 4a-3 but unused at any 4a-1 call site.
//   5. COVERAGE RECOMPUTE is explicit (closes the legacy
//      addManualFieldMapping gap).
//   6. ACTIVITY LOG emits 'mapping_created' AFTER the RPC succeeds with
//      the agreed payload format.
//   7. CUSTOM_SQL is BLOCKED on the way in (the form layer in 4a-2 will
//      surface the tooltip; the wrapper is the second line of defense).
//   8. SUGGEST does NOT emit an activity_log entry.
//   9. SUGGEST's AI_INVALID_RESPONSE codepath returns when the LLM
//      output is unparseable OR resolves zero usable source fields.
//  10. SUGGEST runs `checkAIRateLimit` BEFORE the LLM call.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// 1. Wrapper exports + module-level shape
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign 4a] wrapper exports', () => {
  it('exports createFieldMapping as an async function', () => {
    expect(SRC).toMatch(/export async function createFieldMapping\(/)
  })

  it('exports suggestMappingForTarget as an async function', () => {
    expect(SRC).toMatch(/export async function suggestMappingForTarget\(/)
  })

  it('exports CreateFieldMappingErrorCode union (with the cross-table reservations)', () => {
    expect(SRC).toMatch(/export type CreateFieldMappingErrorCode/)
    // 4a-1 emitter
    expect(SRC).toMatch(/['"]CROSS_TABLE_NOT_YET_SUPPORTED['"]/)
    // 4a-3 placeholder, unused emitter today
    expect(SRC).toMatch(/['"]CROSS_TABLE_AMBIGUOUS['"]/)
  })

  it('exports SuggestMappingErrorCode union (with rate limit + invalid-response codes)', () => {
    expect(SRC).toMatch(/export type SuggestMappingErrorCode/)
    expect(SRC).toMatch(/['"]RATE_LIMITED['"]/)
    expect(SRC).toMatch(/['"]AI_INVALID_RESPONSE['"]/)
  })

  it('exports the result discriminated unions', () => {
    expect(SRC).toMatch(/export type CreateFieldMappingResult/)
    expect(SRC).toMatch(/export type SuggestMappingForTargetResult/)
  })

  it('exports CreateFieldMappingCombinationType narrowed to the 3 user-selectable values (custom_sql excluded)', () => {
    expect(SRC).toMatch(/export type CreateFieldMappingCombinationType/)
    const typeSection = sliceBetween(
      SRC,
      'export type CreateFieldMappingCombinationType',
      '\n\n',
    )
    expect(typeSection).toContain("'single'")
    expect(typeSection).toContain("'concat_space'")
    expect(typeSection).toContain("'concat_comma'")
    expect(typeSection).not.toContain("| 'custom_sql'")
  })

  it('imports the maintenance-mode guard primitive (not the legacy guardWrites helper)', () => {
    // legacy guardWrites is module-private to lib/actions/mappings.ts;
    // wrapper calls assertMappingWritesEnabled directly.
    expect(SRC).toContain("from '@/lib/auth/mapping-writes'")
    expect(SRC).toMatch(/assertMappingWritesEnabled/)
  })

  it('imports recomputeTableMappingStatus to close the legacy coverage gap', () => {
    expect(SRC).toMatch(/recomputeTableMappingStatus/)
  })

  it('imports next/cache revalidatePath for redirect-after-write coherence', () => {
    expect(SRC).toContain("from 'next/cache'")
    expect(SRC).toMatch(/revalidatePath/)
  })

  it('imports the AI plumbing for suggestMappingForTarget', () => {
    expect(SRC).toContain("from '@/lib/ai/claude'")
    expect(SRC).toContain("from '@/lib/ai/rate-limit'")
    expect(SRC).toContain("from '@/lib/ai/context-builder'")
    expect(SRC).toMatch(/callClaude/)
    expect(SRC).toMatch(/checkAIRateLimit/)
    expect(SRC).toMatch(/buildAIContext/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. createFieldMapping — validation, permission, RPC, activity log
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign 4a] createFieldMapping', () => {
  const body = sliceBetween(
    SRC,
    'export async function createFieldMapping(',
    '// ─── Helper: find-or-create table_mappings',
  )

  // ── Validation block (cheap checks before any I/O) ────────────────

  it('rejects empty / missing projectId or targetFieldId with VALIDATION', () => {
    expect(body).toMatch(/!projectId\s*\|\|\s*!targetFieldId/)
    expect(body).toMatch(
      /!projectId[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it('rejects empty sourceFieldIds with VALIDATION', () => {
    expect(body).toMatch(
      /sourceFieldIds\.length\s*===\s*0[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it("blocks combinationType === 'custom_sql' at the wrapper boundary (Transform-tab redirect)", () => {
    expect(body).toMatch(/combinationType\s*===\s*['"]custom_sql['"]/)
    expect(body).toMatch(
      /custom_sql[\s\S]{0,300}errorCode:\s*['"]VALIDATION['"]/,
    )
    // Copy directs the user to the Transform tab.
    expect(body).toMatch(/Transform tab/)
  })

  it("requires exactly one source for combinationType === 'single'", () => {
    expect(body).toMatch(
      /combinationType\s*===\s*['"]single['"]\s*&&\s*sourceFieldIds\.length\s*!==\s*1/,
    )
  })

  it('requires 2+ sources for non-single combination types', () => {
    expect(body).toMatch(
      /combinationType\s*!==\s*['"]single['"]\s*&&\s*sourceFieldIds\.length\s*<\s*2/,
    )
  })

  it('rejects duplicate sourceFieldIds (defense-in-depth against picker bugs)', () => {
    expect(body).toMatch(
      /new Set\(sourceFieldIds\)\.size\s*!==\s*sourceFieldIds\.length/,
    )
    expect(body).toMatch(/Duplicate source fields[\s\S]{0,200}VALIDATION/)
  })

  // ── Auth + permission ─────────────────────────────────────────────

  it('checks auth via supabase.auth.getUser() and returns PERMISSION_DENIED on missing user', () => {
    expect(body).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(body).toMatch(
      /if\s*\(\s*!user\s*\)[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })

  it('checks editor permission via requireProjectPermission(projectId, "editor")', () => {
    expect(body).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
    expect(body).toMatch(/!perm\.allowed[\s\S]{0,200}PERMISSION_DENIED/)
  })

  it('runs assertMappingWritesEnabled (maintenance guard) before any DB write', () => {
    expect(body).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    // Maintenance message → MAINTENANCE_MODE errorCode.
    expect(body).toMatch(
      /Mapping writes are temporarily disabled[\s\S]{0,300}MAINTENANCE_MODE/,
    )
  })

  // ── Cross-table guard (founder decision 1: 4a-1 same-table only) ──

  it('returns CROSS_TABLE_NOT_YET_SUPPORTED when sources span multiple source tables', () => {
    expect(body).toMatch(/uniqueSourceTableIds\.size\s*>\s*1/)
    // The literal contains BOTH the deferral copy and the errorCode
    // (order in the object literal varies), so just assert co-presence
    // within a small window of the size > 1 guard.
    expect(body).toMatch(
      /uniqueSourceTableIds\.size\s*>\s*1[\s\S]{0,500}CROSS_TABLE_NOT_YET_SUPPORTED/,
    )
    expect(body).toMatch(/Cross-table mappings coming in Phase 4a-3/)
  })

  it('does NOT emit CROSS_TABLE_AMBIGUOUS in 4a-1 (reserved for 4a-3 FK precheck)', () => {
    // The errorCode appears in the union (verified above) but is never
    // returned from any return statement at this stage. Search for
    // `errorCode: 'CROSS_TABLE_AMBIGUOUS'` specifically.
    expect(body).not.toMatch(/errorCode:\s*['"]CROSS_TABLE_AMBIGUOUS['"]/)
  })

  // ── Existing-TFM collision (founder decision 3) ───────────────────

  it('queries the existing TFM by (project_id, target_field_id) before create', () => {
    expect(body).toContain("from('target_field_mappings')")
    expect(body).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/)
    expect(body).toMatch(
      /\.eq\(\s*['"]target_field_id['"]\s*,\s*targetFieldId\s*\)/,
    )
    expect(body).toMatch(/maybeSingle\(\)/)
  })

  it('returns the locked-copy VALIDATION error on collision with a live TFM', () => {
    // The exact copy the founder locked in decision 3.
    expect(body).toMatch(
      /This target field was mapped while you were editing\. Refresh to see the current state\./,
    )
  })

  it('handles the bare-acknowledgment exception by silently deleting pre-create', () => {
    // Bare-ack = is_acknowledged=true AND combination_type=null.
    // Wrapper deletes the row before delegating to the RPC.
    expect(body).toMatch(/is_acknowledged\s*===\s*true/)
    expect(body).toMatch(/combination_type\s*===\s*null/)
    // Deletion path uses the admin client.
    expect(body).toMatch(/supabaseAdmin[\s\S]{0,200}\.delete\(\)/)
  })

  // ── RPC call (founder decision 2: status='needs_review' on create) ─

  it('calls the dq_create_target_field_mapping RPC (atomic TFM + sources insert)', () => {
    expect(body).toMatch(
      /supabase\.rpc\(\s*['"]dq_create_target_field_mapping['"]/,
    )
  })

  it("does NOT issue a follow-up UPDATE flipping status to 'approved' (founder decision 2)", () => {
    // The RPC hardcodes status='needs_review'. Wrapper must not override.
    expect(body).not.toMatch(
      /status:\s*['"]approved['"][\s\S]{0,300}\.update\(/,
    )
    expect(body).not.toMatch(/\.update\([\s\S]{0,200}status:\s*['"]approved['"]/)
  })

  it('threads aiReasoning through to p_combination.ai_reasoning (founder decision 4)', () => {
    expect(body).toMatch(/ai_reasoning/)
    expect(body).toMatch(/aiReasoning/)
  })

  it("emits ordinal: idx so the dominant source lives at ordinal 0", () => {
    // Map+idx pattern → ordinal: idx → first input id is dominant.
    expect(body).toMatch(/ordinal:\s*idx/)
  })

  // ── Coverage recompute (founder decision 5: closes legacy gap) ────

  it('calls recomputeTableMappingStatus after the RPC succeeds', () => {
    // RPC call is multi-line in the source — match by the rpc method name
    // alone, then locate the recompute call after it.
    const rpcIdx = body.search(/supabase\.rpc\(/)
    const recomputeIdx = body.indexOf('recomputeTableMappingStatus(')
    expect(rpcIdx).toBeGreaterThan(0)
    expect(recomputeIdx).toBeGreaterThan(rpcIdx)
  })

  // ── revalidatePath ────────────────────────────────────────────────

  it('revalidates BOTH the mapping and transform paths (transform reflects new mapping)', () => {
    expect(body).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/mapping`/,
    )
    expect(body).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/transform`/,
    )
  })

  // ── Activity log (founder decision 6) ─────────────────────────────

  it("emits a 'mapping_created' activity log entry AFTER the RPC succeeds", () => {
    const rpcIdx = body.search(/supabase\.rpc\(/)
    const logIdx = body.indexOf('logActivity(')
    expect(rpcIdx).toBeGreaterThan(0)
    expect(logIdx).toBeGreaterThan(rpcIdx)
    expect(body).toMatch(/['"]mapping_created['"]/)
    expect(body).toMatch(/['"]mapping['"]/)
  })

  it('payload includes target/source identity, combination_type, ai_suggested, cross_table flags', () => {
    expect(body).toMatch(/target_field_mapping_id/)
    expect(body).toMatch(/target_field_id/)
    expect(body).toMatch(/source_field_ids/)
    expect(body).toMatch(/combination_type:/)
    expect(body).toMatch(/ai_suggested/)
    expect(body).toMatch(/cross_table/)
  })

  it('description payload distinguishes manual vs AI-suggested creates', () => {
    expect(body).toMatch(/AI-suggested mapping/)
    expect(body).toMatch(/Mapping created/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. findOrCreateTableMapping helper — internal extraction
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign 4a] findOrCreateTableMapping helper', () => {
  it('exists as an internal (non-exported) async function', () => {
    expect(SRC).toMatch(/^async function findOrCreateTableMapping\(/m)
    expect(SRC).not.toMatch(/^export async function findOrCreateTableMapping/m)
    expect(SRC).not.toMatch(/^export function findOrCreateTableMapping/m)
  })

  const helperBody = sliceBetween(
    SRC,
    'async function findOrCreateTableMapping(',
    '// ─── Per-target AI Suggest',
  )

  it('looks up an existing table_mappings row by (project, source, target) tuple', () => {
    expect(helperBody).toContain("from('table_mappings')")
    expect(helperBody).toMatch(/\.eq\(\s*['"]project_id['"]/)
    expect(helperBody).toMatch(/\.eq\(\s*['"]source_table_id['"]/)
    expect(helperBody).toMatch(/\.eq\(\s*['"]target_table_id['"]/)
  })

  it('inserts a new TM row with status=needs_review when none exists', () => {
    expect(helperBody).toMatch(
      /insert\(\{[\s\S]{0,400}status:\s*['"]needs_review['"]/,
    )
  })

  it('uses the admin client (project membership already verified by caller)', () => {
    expect(helperBody).toContain('supabaseAdmin')
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. suggestMappingForTarget — auth, rate limit, LLM, parsing
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign 4a] suggestMappingForTarget', () => {
  // The function is the last in the file; slice to EOF marker.
  const body = SRC.slice(SRC.indexOf('export async function suggestMappingForTarget('))

  it('checks auth + editor permission BEFORE the rate limiter (cheap-check ordering)', () => {
    const userIdx = body.indexOf('supabase.auth.getUser()')
    const permIdx = body.indexOf('requireProjectPermission(')
    const rlIdx = body.indexOf('checkAIRateLimit(')
    expect(userIdx).toBeGreaterThan(0)
    expect(permIdx).toBeGreaterThan(userIdx)
    expect(rlIdx).toBeGreaterThan(permIdx)
  })

  it('runs checkAIRateLimit BEFORE the LLM call (avoid wasted tokens)', () => {
    const rlIdx = body.indexOf('checkAIRateLimit(')
    const llmIdx = body.indexOf('callClaude(')
    expect(rlIdx).toBeGreaterThan(0)
    expect(llmIdx).toBeGreaterThan(rlIdx)
    expect(body).toMatch(
      /!rateLimit\.allowed[\s\S]{0,300}errorCode:\s*['"]RATE_LIMITED['"]/,
    )
  })

  it('builds AI context via buildAIContext with the project-scoped scope', () => {
    expect(body).toMatch(/buildAIContext\(/)
    // We use distributions + samples + documents.
    expect(body).toMatch(/includeValueDistributions/)
    expect(body).toMatch(/includeSampleValues/)
    expect(body).toMatch(/includeDocuments/)
  })

  it('passes user.id to buildAIContext so migration intelligence is hydrated', () => {
    // The buildAIContext call is multi-line with a scope object literal;
    // assert co-presence of `projectId` and `user.id` arguments within
    // a generous window after the call site.
    expect(body).toMatch(
      /buildAIContext\([\s\S]{0,800}user\.id[\s\S]{0,100}\)/,
    )
  })

  it('runs a companion (id, name, table_id) query against fields (FieldContext lacks id)', () => {
    // FieldContext from lib/ai/context-builder.ts intentionally hides
    // UUIDs — name→id translation needs its own query.
    expect(body).toMatch(/from\(['"]fields['"]\)[\s\S]{0,300}id, name, table_id/)
  })

  it('calls callClaude with the prompt and a max_tokens budget', () => {
    expect(body).toMatch(/callClaude\(/)
    expect(body).toMatch(/1024/)
  })

  it('parses the LLM response with code-fence stripping (matches legacy parseClaudeJSON pattern)', () => {
    expect(body).toMatch(/```/)
    expect(body).toMatch(/JSON\.parse\(/)
  })

  it('returns AI_INVALID_RESPONSE when JSON.parse throws', () => {
    expect(body).toMatch(
      /JSON\.parse[\s\S]{0,200}AI_INVALID_RESPONSE/,
    )
  })

  it('returns AI_INVALID_RESPONSE when source_field_names is not an array', () => {
    expect(body).toMatch(
      /Array\.isArray\(parsed\.source_field_names\)[\s\S]{0,300}AI_INVALID_RESPONSE/,
    )
  })

  it('returns AI_INVALID_RESPONSE when zero usable source fields resolve', () => {
    expect(body).toMatch(
      /resolvedIds\.length\s*===\s*0[\s\S]{0,400}AI_INVALID_RESPONSE/,
    )
  })

  it('strips invalid suggested IDs without aborting (lenient resolver)', () => {
    // Loop: for each rawName, look up; skip if missing.
    expect(body).toMatch(/sourceFieldsByLowerName\.get\(/)
    // Skip + dedupe pattern.
    expect(body).toMatch(/continue/)
  })

  it('enforces same-table on the LLM output (prompt instructs same-table; double-check on parse)', () => {
    expect(body).toMatch(/resolvedTableIds\.size\s*>\s*1/)
  })

  it('emits NO activity_log entry on invocation (suggestions are ephemeral)', () => {
    // logActivity calls in the wrapper exist for createFieldMapping
    // and rejectFieldMapping, but the suggest body must not contain
    // one — the assertion is local to the suggest function body.
    expect(body).not.toMatch(/logActivity\(/)
  })

  it('uses Math.round / Number.isFinite to clamp confidence into [0, 100]', () => {
    expect(body).toMatch(/Number\.isFinite/)
    expect(body).toMatch(/Math\.round/)
  })

  it('truncates the rationale to RATIONALE_MAX_CHARS', () => {
    expect(body).toMatch(/RATIONALE_MAX_CHARS/)
    expect(body).toMatch(/rationaleRaw\.slice\(/)
  })

  it("defaults combinationType to 'concat_space' when 2+ sources resolve and the LLM emits a non-comma value (decision 7)", () => {
    expect(body).toMatch(/['"]concat_space['"]/)
    expect(body).toMatch(/['"]concat_comma['"]/)
    // Single-source override: 1 resolved id → 'single'.
    expect(body).toMatch(
      /resolvedIds\.length\s*===\s*1[\s\S]{0,200}['"]single['"]/,
    )
  })

  it('does NOT issue any DB write (suggestion is read-only / ephemeral)', () => {
    // No INSERT / UPDATE / DELETE / RPC call on the create-side path.
    expect(body).not.toMatch(/\.insert\(/)
    expect(body).not.toMatch(/\.update\(/)
    expect(body).not.toMatch(/\.delete\(/)
    expect(body).not.toMatch(
      /supabase\.rpc\(\s*['"]dq_create_target_field_mapping['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. Result-type boundary
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign 4a] result-type boundary', () => {
  it('CreateFieldMappingResult is a discriminated union on `success`', () => {
    expect(SRC).toMatch(/success:\s*true[\s\S]{0,200}tfmId:\s*string/)
    expect(SRC).toMatch(/success:\s*false[\s\S]{0,200}errorCode:\s*CreateFieldMappingErrorCode/)
  })

  it('SuggestMappingForTargetResult is a discriminated union on `success` with the required suggestion shape', () => {
    expect(SRC).toMatch(/sourceFieldIds:\s*string\[\]/)
    expect(SRC).toMatch(/combinationType:\s*CreateFieldMappingCombinationType/)
    expect(SRC).toMatch(/confidence:\s*number/)
    expect(SRC).toMatch(/rationale:\s*string/)
  })
})
