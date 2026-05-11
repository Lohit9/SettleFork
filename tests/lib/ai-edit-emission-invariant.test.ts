// @vitest-environment node
//
// Phase 0c PR 9 — audit completeness invariant.
//
// Every server action that writes to one of the AI-mutating tables
// (target_field_mappings, mapping_sources, transformations,
// validation_rules, quality_issues) MUST also call `logAIEdit` so
// the structured-diff history in `public.ai_edit_history` stays
// faithful to what actually changed in the database.
//
// Strategy
// --------
// Walk lib/actions/**, lib/ai/**, lib/quality/**, lib/auth/**. For each
// file, slice into top-level function bodies (`(export )?async function
// NAME(`). For each function:
//
//   1. Detect AI-mutation patterns:
//      `.from('<ai_table>')` followed by `.insert(` / `.update(` /
//      `.upsert(` / `.delete(`, allowing chained methods (`.select()`,
//      `.eq()`, `.maybeSingle()`, etc.) in between.
//
//   2. If a mutation is detected, require `logAIEdit(` in the same
//      function body OR an entry in `ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT`.
//
//   3. RPC-routed writes (`supabase.rpc('dq_create_target_field_mapping')`,
//      etc.) are NOT detected by this pattern. Provenance for those
//      sites is wired manually in the calling server action via the
//      post-call SELECT pattern (see runMappingGenerationForPair,
//      suggestRemainingMappings).
//
// Allow-list discipline (per investigation §8.2)
// ----------------------------------------------
// The allow-list is a release valve, not an escape hatch. Each entry
// MUST carry a comment explaining WHY the function legitimately does
// not need provenance. Entries split into two camps:
//
//   - Permanent skips: deterministic test runners, status-cascade
//     recomputers, internal cleanup helpers, value-assignment scope
//     (out-of-scope per investigation §1.7).
//
//   - Phase 0c follow-up: bulk ops + heavy mutators in mappings.ts
//     and quality-fixes.ts that need careful per-row state-capture
//     work. Will be wired in a focused follow-up PR after this
//     invariant lands; the allow-list documents the working set.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')

const SCAN_ROOTS = ['lib/actions', 'lib/ai', 'lib/quality', 'lib/auth']

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '__tests__',
  'tests',
])

const AI_TABLES = [
  'target_field_mappings',
  'mapping_sources',
  'transformations',
  'validation_rules',
  'quality_issues',
] as const

const ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT = new Set<string>([
  // ── Permanent skips: not "edits" in the human-vs-AI sense ───────────────
  // Status-cascade recomputers — sweep over rows, no per-edit semantic.
  'recomputeTableMappingStatus',
  // Internal cleanup helpers called from already-emitted parents.
  'handleTargetFieldConflict',
  'cleanupOrphanedContributors',
  // Value-assignment commit-trigger machinery — out of scope per
  // investigation §1.7 (value_assignments tracked via deterministic
  // outputs, not as an "edit" surface).
  'ensureValueAssignment',
  'dismissValueAssignment',
  'reinstateValueAssignment',
  'createValueAssignment',
  'replaceValueAssignment',
  // Deterministic test runners — write the test_results column on
  // transformations as a side effect of running a deterministic test;
  // not an AI edit.
  'runFullTransformTest',
  'testTransformation',
  // Engine-internal persistence helper. Routes writes through the
  // dq_create_target_field_mapping RPC, not direct .from(...).insert,
  // so this regex never flags it. Listed defensively in case a future
  // refactor adds a fallback direct-write branch.
  'persistClaudeFieldMappingsForTM',

  // ── Permanent skips: deterministic detection / validation engines ───────
  // These functions write quality_issues rows from deterministic rule
  // execution, not from AI proposals. The Phase 0c provenance contract
  // captures AI-vs-human edits; rule-driven inserts have no AI side.
  'runSourceDataChecks',
  'runStagedValidation',
  'runInFlightChecksInternal',
  'executeCustomRules',

  // ── Permanent skips: schema/cascade automation, not AI edits ────────────
  // These are deterministic schema-side operations: bulk import from
  // connectors, DDL merge, FK cascade staling. They mutate AI tables as
  // a side effect of well-defined schema operations, not from AI
  // proposals or human edits to AI values. No provenance row makes
  // sense per row.
  'importTableFromClient',
  'confirmDDLSchema',
  'cascadeTransformToFKs',
  'staleFKDependentTransforms',
  'routeConflictToValidationRule',
  'mergeConstraintsFromDDL',
  'stageAllData',
  // removeAcknowledgment toggles is_acknowledged on a TFM; semantically
  // similar to dismissTransformNeeded/reinstateTransformNeeded but lives
  // in field-acknowledgments.ts and is wired through a different UX
  // flow. Phase 0c follow-up will harmonize the three.
  'removeAcknowledgment',
  // removeTable (lib/actions/tables.ts) issues an FK-cascade-driven delete
  // of a `tables` row — fields, mapping_sources, target_field_mappings,
  // transformations, validation_rules, quality_issues etc. all CASCADE
  // automatically (see migrations 002, 074, 093). The action also runs a
  // post-cascade cleanup of orphaned TFMs (combination_type single/concat_*
  // with zero remaining mapping_sources). The whole operation is captured
  // at the parent level in activity_log via `logActivity('table_removed')`;
  // per-row logAIEdit on cascade-deleted TFMs would create duplicate
  // provenance for an event already audited at the parent. Mirrors the
  // schema-cascade-automation rationale above.
  'removeTable',

  // ── Phase 0c follow-up — bulk + heavy mutators ───────────────────────────
  // Will be wired in a focused follow-up PR after this invariant lands.
  // Each of these does meaningful per-row state-capture work that benefits
  // from careful design rather than a tail of PR 9. The allow-list is
  // the working set for that follow-up.
  // mappings.ts:
  'editFieldMapping',
  'addManualFieldMapping',
  'deleteFieldMapping',
  'mapUnmappedField',
  'regenerateFieldMappings',
  'approveAllFieldMappings',
  'rejectAllFieldMappings',
  'approveHighConfidenceMappings',
  'addManualTableMapping',
  'updateTableMappingStatus',
  'deleteTableMapping',
  // mappings-for-redesign.ts (UI-side wrappers):
  'createFieldMapping',
  'editMappingSources',
  'updateMappingCombination',
  'bulkApproveFieldMappingsForTargetTable',
  'bulkRejectFieldMappingsForTargetTable',
  // Flat (spreadsheet) Mapping view server actions — same Phase 0c
  // follow-up bucket as the sibling redesign wrappers above. These
  // inline-edit actions write to target_field_mappings (status flip
  // + optional target_field_id) and mapping_sources (source_field_id
  // + confidence). Per-row provenance wiring lands with the broader
  // Phase 0c wire-up pass. createMappingFromUnmapped delegates to
  // createFieldMapping (already allow-listed); listing it explicitly
  // here too so the audit doesn't flag the post-create status-flip
  // UPDATE that lives in this wrapper.
  'updateMappingSourceField',
  'updateMappingTargetField',
  'createMappingFromUnmapped',
  // setUnmappedRowRejected writes target_field_coverage (not in
  // AI_TABLES) and source_field_acknowledgments (not in AI_TABLES) —
  // not strictly required on the allow-list today, but listed
  // defensively to document the flat-view surface as a single block
  // for the follow-up reviewer.
  'setUnmappedRowRejected',
  // quality-fixes.ts + manual-fix.ts:
  'markIssueFixed',
  'applyManualFix',
  'runFullScan',
  'triggerStagedValidation',

  // ── Path D foundation (Sub-PR 4a) ────────────────────────────────────────
  // path-d-persistence.ts:persistMappings is the bulk-upsert leg of the
  // Path D monolithic Opus 4.7 mapping pipeline. Per-row provenance for a
  // bulk AI generation needs careful per-row state-capture design (the
  // existing Phase 0c follow-up pattern); wiring it at the orchestrator
  // boundary instead of the persistence helper is also under consideration.
  // Flag-gated OFF by default (AI_MAPPING_PATH_D_ENABLED), and Sub-PR 4a
  // ships only the foundation — the orchestrator that calls this is
  // stubbed (returns notImplementedError) until Sub-PR 4b. Provenance
  // wiring lands with the orchestrator in 4b.
  'persistMappings',

  // ── Path D INF-45 — mapping_sources persistence ──────────────────────────
  // path-d-persistence.ts:persistMappingSources is the Pass 2.5 sibling
  // of persistMappings (added in INF-45 to fix the production bug where
  // Path D wrote TFM shells without source associations). Same allow-list
  // rationale as persistMappings above: provenance for the bulk Path D
  // run fires at the orchestrator boundary via emitPathDProvenance, not
  // per-table-write inside the persistence helpers. Wiring logAIEdit
  // here would double-emit per source row (already covered by the per-
  // TFM provenance row that emitPathDProvenance writes after the parent
  // TFM upsert).
  'persistMappingSources',

  // ── Path D orchestrator (Sub-PR 4b) ──────────────────────────────────────
  // path-d-mapping.ts:emitPathDProvenance is itself the provenance emitter
  // for the Path D bulk run — it READS target_field_mappings (just inserted
  // by persistMappings) and INSERTS into ai_edit_history. The audit regex
  // greedily matches `.from('target_field_mappings')` (the read) followed
  // within 2000 chars by `.insert(` (on ai_edit_history) and reports a
  // false-positive write to `target_field_mappings`. The function does
  // NOT write `target_field_mappings`; allow-listing it documents the
  // false positive and keeps the audit's other invariants (the orchestrator
  // boundary IS where Path D's provenance fires; this function is the
  // boundary).
  'emitPathDProvenance',
])

// ─────────────────────────────────────────────────────────────────────────────
// Walker

function walkSourceFiles(roots: string[]): string[] {
  const out: string[] = []
  function recurse(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
      if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        recurse(full)
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(full)
      }
    }
  }
  for (const root of roots) {
    recurse(resolve(REPO_ROOT, root))
  }
  return out
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ─────────────────────────────────────────────────────────────────────────────
// Function slicer
//
// Splits a file into [{ name, body }] slices keyed on top-level
// `(export )?async function NAME(`. Each body runs from the function's
// declaration line to the start of the next function (or EOF). Not a
// proper TS parser, but robust enough for production server-action
// files that consistently declare functions at the top level.

interface FunctionSlice {
  name: string
  body: string
  startLine: number
}

function sliceFunctions(src: string): FunctionSlice[] {
  const slices: FunctionSlice[] = []
  // Match `(export )?async function NAME(` capturing the name. Anchored
  // to start-of-line to skip inner functions and nested arrow callbacks.
  const re = /^(?:export\s+)?async\s+function\s+([A-Za-z0-9_]+)\s*[<(]/gm
  const matches: Array<{ name: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    matches.push({ name: m[1]!, index: m.index })
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index
    const end = i + 1 < matches.length ? matches[i + 1]!.index : src.length
    const body = src.slice(start, end)
    const startLine = src.slice(0, start).split('\n').length
    slices.push({ name: matches[i]!.name, body, startLine })
  }
  return slices
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation detector

function functionWritesAITable(body: string): { table: string } | null {
  for (const table of AI_TABLES) {
    // Match `.from('<table>')` then any chain of methods, then a write verb.
    // The `.{0,2000}?` non-greedy guard caps how far the chain can stretch
    // so we don't match unrelated writes appearing later in the body.
    const re = new RegExp(
      `\\.from\\(\\s*['"]${table}['"]\\s*\\)[\\s\\S]{0,2000}?\\.(insert|update|upsert|delete)\\s*\\(`,
    )
    if (re.test(body)) return { table }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests

describe('[ai-edit-history audit completeness] every AI-table write must call logAIEdit', () => {
  const files = walkSourceFiles(SCAN_ROOTS)

  it('walker picks up production files (sanity)', () => {
    expect(files.length).toBeGreaterThan(20)
    const rels = files.map((f) => f.replace(REPO_ROOT + '/', ''))
    expect(rels).toContain('lib/actions/transformations.ts')
    expect(rels).toContain('lib/actions/mappings.ts')
    expect(rels).toContain('lib/actions/quality-fixes.ts')
    expect(rels).toContain('lib/actions/validation-rules.ts')
    expect(rels).toContain('lib/actions/ai-edit-history.ts')
  })

  it('every AI-table-write function calls logAIEdit (or is allow-listed)', () => {
    const violations: Array<{ file: string; fn: string; table: string }> = []

    for (const abs of files) {
      const rel = abs.replace(REPO_ROOT + '/', '')
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const slices = sliceFunctions(code)

      for (const slice of slices) {
        const writeMatch = functionWritesAITable(slice.body)
        if (!writeMatch) continue
        if (slice.body.includes('logAIEdit(')) continue
        if (ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT.has(slice.name)) continue
        violations.push({ file: rel, fn: slice.name, table: writeMatch.table })
      }
    }

    expect(
      violations,
      `Functions writing AI-mutating tables without logAIEdit (and not allow-listed):\n` +
        violations.map((v) => `  ${v.file}: ${v.fn} → ${v.table}`).join('\n') +
        `\n\nEither add a logAIEdit call in the same function body, or add the function name\n` +
        `to ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT in this test with a comment explaining why.`,
    ).toEqual([])
  })

  it('the allow-list itself is sane — every entry corresponds to a function that exists in the codebase', () => {
    const allFunctionNames = new Set<string>()
    for (const abs of files) {
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      for (const slice of sliceFunctions(code)) {
        allFunctionNames.add(slice.name)
      }
    }

    const orphaned: string[] = []
    for (const allowed of ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT) {
      if (!allFunctionNames.has(allowed)) orphaned.push(allowed)
    }

    expect(
      orphaned,
      `Allow-list entries that don't match any function in the scanned codebase:\n` +
        orphaned.map((o) => `  ${o}`).join('\n') +
        `\n\nThese entries are dead — remove them from ALLOWED_FUNCTIONS_WITHOUT_LOG_AI_EDIT.`,
    ).toEqual([])
  })

  it('every wired-with-logAIEdit function actually contains a write to an AI-mutating table (not stale wiring)', () => {
    const stale: Array<{ file: string; fn: string }> = []

    for (const abs of files) {
      const rel = abs.replace(REPO_ROOT + '/', '')
      // Skip the helper itself — it defines logAIEdit but doesn't write
      // through .from(...).
      if (rel === 'lib/actions/ai-edit-history.ts') continue
      const raw = readFileSync(abs, 'utf-8')
      const code = stripComments(raw)
      const slices = sliceFunctions(code)

      for (const slice of slices) {
        if (!slice.body.includes('logAIEdit(')) continue
        // Three legitimate reasons a function may carry logAIEdit without
        // a direct AI-table write:
        //   - It writes via an RPC (e.g. dq_create_target_field_mapping)
        //   - It is a fan-out wrapper that reads back created TFMs
        //     post-RPC and emits per-row.
        //   - It anchors a "virtual" provenance event (e.g.
        //     suggestTransformDescription) on a parent entity.
        // For all three we accept the emit even without a direct
        // .from(...).insert/update/.... pattern in the same body.
        if (functionWritesAITable(slice.body)) continue
        if (
          slice.body.includes('.rpc(') ||
          slice.body.includes('persistClaudeFieldMappingsForTM(')
        )
          continue
        // Virtual-anchor cases — these don't write to AI tables but emit
        // for traceability per the user's PR 9 spec.
        const VIRTUAL_ANCHORS = new Set<string>([
          'suggestTransformDescription',
        ])
        if (VIRTUAL_ANCHORS.has(slice.name)) continue
        stale.push({ file: rel, fn: slice.name })
      }
    }

    expect(
      stale,
      `Functions calling logAIEdit but with no detectable AI-table write or RPC route:\n` +
        stale.map((s) => `  ${s.file}: ${s.fn}`).join('\n') +
        `\n\nEither remove the logAIEdit call (no longer load-bearing) or document\n` +
        `the indirect-write rationale by adding the function name to VIRTUAL_ANCHORS.`,
    ).toEqual([])
  })
})
