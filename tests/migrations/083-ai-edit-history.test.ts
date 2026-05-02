// @vitest-environment node
//
// Source-level invariant tests for migration
// `supabase/migrations/083_ai_edit_history.sql`.
//
// SQL invariants here are pinned because PR 9 (Phase 0c emission
// wiring) and the future migration-intelligence canonicalization PR
// both depend on the exact shape of ai_edit_history and the
// original_ai_* columns. A regression in any of these (forgetting
// the FK to llm_calls, dropping the partial thinking index, weakening
// RLS) would either break PR 9 or silently lose provenance data.
//
// Behavioral correctness (RLS visibility, FK cascade behavior,
// backfill correctness against real data) is covered by a future
// env-gated integration test against scratch supabase, not part of
// the standard quality gate.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(__dirname, '../../supabase/migrations/083_ai_edit_history.sql'),
  'utf8',
)

// ──────────────────────────────────────────────────────────────────────────
// Group A: ai_edit_history table shape
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — ai_edit_history table shape', () => {
  it('§A.1 — id UUID PRIMARY KEY DEFAULT gen_random_uuid()', () => {
    expect(SQL).toMatch(
      /id\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i,
    )
  })

  it('§A.2 — project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE', () => {
    expect(SQL).toMatch(
      /project_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+public\.projects\(id\)\s+ON\s+DELETE\s+CASCADE/i,
    )
  })

  it('§A.3 — actor_id UUID NOT NULL REFERENCES auth.users(id)', () => {
    expect(SQL).toMatch(
      /actor_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+auth\.users\(id\)/i,
    )
  })

  it('§A.4 — entity_type TEXT NOT NULL with CHECK on the 5-entity locked enum', () => {
    expect(SQL).toMatch(/entity_type\s+TEXT\s+NOT\s+NULL/i)
    const checkMatch = SQL.match(
      /entity_type[\s\S]+?CHECK\s*\(\s*entity_type\s+IN\s*\(([\s\S]+?)\)\s*\)/i,
    )
    expect(checkMatch).not.toBeNull()
    const list = checkMatch![1]
    expect(list).toMatch(/'target_field_mapping'/i)
    expect(list).toMatch(/'mapping_source'/i)
    expect(list).toMatch(/'transformation'/i)
    expect(list).toMatch(/'validation_rule'/i)
    expect(list).toMatch(/'quality_issue'/i)
  })

  it('§A.5 — entity_id UUID NOT NULL, field_path TEXT NOT NULL', () => {
    expect(SQL).toMatch(/entity_id\s+UUID\s+NOT\s+NULL/i)
    expect(SQL).toMatch(/field_path\s+TEXT\s+NOT\s+NULL/i)
  })

  it('§A.6 — old_value JSONB and new_value JSONB (both nullable, no NOT NULL)', () => {
    // Match the column definition lines specifically — NOT NULL appears
    // on other columns so we anchor the regex to the line.
    const oldMatch = SQL.match(/^\s*old_value\s+JSONB[^,]*,?\s*$/im)
    const newMatch = SQL.match(/^\s*new_value\s+JSONB[^,]*,?\s*$/im)
    expect(oldMatch).not.toBeNull()
    expect(newMatch).not.toBeNull()
    expect(oldMatch![0]).not.toMatch(/NOT\s+NULL/i)
    expect(newMatch![0]).not.toMatch(/NOT\s+NULL/i)
  })

  it('§A.7 — edit_kind TEXT NOT NULL with CHECK on the 6-kind locked enum', () => {
    expect(SQL).toMatch(/edit_kind\s+TEXT\s+NOT\s+NULL/i)
    const checkMatch = SQL.match(
      /edit_kind[\s\S]+?CHECK\s*\(\s*edit_kind\s+IN\s*\(([\s\S]+?)\)\s*\)/i,
    )
    expect(checkMatch).not.toBeNull()
    const list = checkMatch![1]
    expect(list).toMatch(/'ai_proposed'/i)
    expect(list).toMatch(/'ai_replaced'/i)
    expect(list).toMatch(/'human_accepted'/i)
    expect(list).toMatch(/'human_modified'/i)
    expect(list).toMatch(/'human_rejected'/i)
    expect(list).toMatch(/'human_authored'/i)
  })

  it('§A.8 — llm_call_id UUID REFERENCES llm_calls(id) ON DELETE SET NULL (nullable)', () => {
    expect(SQL).toMatch(
      /llm_call_id\s+UUID\s+REFERENCES\s+public\.llm_calls\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i,
    )
    // Column line should not carry NOT NULL — provenance is allowed to be
    // a human-only edit.
    const lineMatch = SQL.match(/^\s*llm_call_id\s+UUID[^,]*,?\s*$/im)
    expect(lineMatch).not.toBeNull()
    expect(lineMatch![0]).not.toMatch(/NOT\s+NULL/i)
  })

  it('§A.9 — metadata JSONB NOT NULL DEFAULT and created_at TIMESTAMPTZ NOT NULL DEFAULT now()', () => {
    expect(SQL).toMatch(/metadata\s+JSONB\s+NOT\s+NULL\s+DEFAULT/i)
    expect(SQL).toMatch(
      /created_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Group B: ai_edit_history indexes
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — ai_edit_history indexes', () => {
  it('§B.1 — composite index on (entity_type, entity_id, created_at DESC)', () => {
    expect(SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ai_edit_history_entity\s+ON\s+public\.ai_edit_history\s*\(\s*entity_type,\s*entity_id,\s*created_at\s+DESC\s*\)/i,
    )
  })

  it('§B.2 — composite index on (project_id, created_at DESC)', () => {
    expect(SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ai_edit_history_project_time\s+ON\s+public\.ai_edit_history\s*\(\s*project_id,\s*created_at\s+DESC\s*\)/i,
    )
  })

  it('§B.3 — composite index on (project_id, edit_kind, created_at DESC)', () => {
    expect(SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ai_edit_history_kind\s+ON\s+public\.ai_edit_history\s*\(\s*project_id,\s*edit_kind,\s*created_at\s+DESC\s*\)/i,
    )
  })

  it('§B.4 — partial index on llm_call_id WHERE llm_call_id IS NOT NULL', () => {
    expect(SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ai_edit_history_llm_call_id\s+ON\s+public\.ai_edit_history\s*\(\s*llm_call_id\s*\)\s+WHERE\s+llm_call_id\s+IS\s+NOT\s+NULL/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Group C: ai_edit_history RLS
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — ai_edit_history RLS', () => {
  it('§C.1 — RLS is enabled on ai_edit_history', () => {
    expect(SQL).toMatch(
      /ALTER\s+TABLE\s+public\.ai_edit_history\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
    )
  })

  it('§C.2 — SELECT policy uses public.user_can_access_project(project_id)', () => {
    expect(SQL).toMatch(
      /CREATE\s+POLICY\s+"ai_edit_history_select_project_members"\s+ON\s+public\.ai_edit_history\s+FOR\s+SELECT\s+USING\s*\(\s*public\.user_can_access_project\s*\(\s*project_id\s*\)\s*\)/i,
    )
  })

  it('§C.3 — NO INSERT/UPDATE/DELETE policies on ai_edit_history (service-role-only writes)', () => {
    // No policy block for ai_edit_history that names INSERT/UPDATE/DELETE/ALL
    // beyond the SELECT one we just verified.
    expect(SQL).not.toMatch(
      /CREATE\s+POLICY\s+[^;]*ON\s+public\.ai_edit_history[\s\S]*?FOR\s+(INSERT|UPDATE|DELETE|ALL)/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Group D: original_ai_* columns on the four hot tables
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — original_ai_* columns', () => {
  it('§D.1 — target_field_mappings adds original_ai_confidence NUMERIC(5,2) and original_ai_reasoning TEXT', () => {
    const block = SQL.match(
      /ALTER\s+TABLE\s+public\.target_field_mappings\s+([\s\S]+?);/i,
    )
    expect(block).not.toBeNull()
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_confidence\s+NUMERIC\(5,2\)/i,
    )
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_reasoning\s+TEXT/i,
    )
    // Must be nullable — no NOT NULL on these columns
    expect(block![1]).not.toMatch(
      /original_ai_confidence\s+NUMERIC\(5,2\)\s+NOT\s+NULL/i,
    )
    expect(block![1]).not.toMatch(/original_ai_reasoning\s+TEXT\s+NOT\s+NULL/i)
  })

  it('§D.2 — mapping_sources adds original_ai_source_field_id UUID, original_ai_confidence NUMERIC(5,2), original_ai_reasoning TEXT', () => {
    const block = SQL.match(
      /ALTER\s+TABLE\s+public\.mapping_sources\s+([\s\S]+?);/i,
    )
    expect(block).not.toBeNull()
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_source_field_id\s+UUID/i,
    )
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_confidence\s+NUMERIC\(5,2\)/i,
    )
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_reasoning\s+TEXT/i,
    )
    // Must be nullable
    expect(block![1]).not.toMatch(
      /original_ai_source_field_id\s+UUID\s+NOT\s+NULL/i,
    )
  })

  it('§D.3 — transformations adds original_ai_generated_sql TEXT (nullable)', () => {
    const block = SQL.match(
      /ALTER\s+TABLE\s+public\.transformations\s+([\s\S]+?);/i,
    )
    expect(block).not.toBeNull()
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_generated_sql\s+TEXT/i,
    )
    expect(block![1]).not.toMatch(
      /original_ai_generated_sql\s+TEXT\s+NOT\s+NULL/i,
    )
  })

  it('§D.4 — quality_issues adds original_ai_fix_options JSONB (nullable)', () => {
    const block = SQL.match(
      /ALTER\s+TABLE\s+public\.quality_issues\s+([\s\S]+?);/i,
    )
    expect(block).not.toBeNull()
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+original_ai_fix_options\s+JSONB/i,
    )
    expect(block![1]).not.toMatch(
      /original_ai_fix_options\s+JSONB\s+NOT\s+NULL/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Group E: Backfill UPDATE statements
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — backfill UPDATE statements', () => {
  it('§E.1 — backfills target_field_mappings WHERE ai_reasoning IS NOT NULL', () => {
    expect(SQL).toMatch(
      /UPDATE\s+public\.target_field_mappings\s+SET\s+original_ai_confidence\s*=\s*confidence,\s+original_ai_reasoning\s*=\s*ai_reasoning\s+WHERE\s+ai_reasoning\s+IS\s+NOT\s+NULL/i,
    )
  })

  it('§E.2 — backfills mapping_sources WHERE ai_reasoning IS NOT NULL', () => {
    expect(SQL).toMatch(
      /UPDATE\s+public\.mapping_sources\s+SET\s+original_ai_source_field_id\s*=\s*source_field_id,\s+original_ai_confidence\s*=\s*confidence,\s+original_ai_reasoning\s*=\s*ai_reasoning\s+WHERE\s+ai_reasoning\s+IS\s+NOT\s+NULL/i,
    )
  })

  it('§E.3 — backfills transformations WHERE is_ai_generated = TRUE AND generated_sql IS NOT NULL', () => {
    expect(SQL).toMatch(
      /UPDATE\s+public\.transformations\s+SET\s+original_ai_generated_sql\s*=\s*generated_sql\s+WHERE\s+is_ai_generated\s*=\s*TRUE\s+AND\s+generated_sql\s+IS\s+NOT\s+NULL/i,
    )
  })

  it('§E.4 — backfills quality_issues WHERE ai_fix_options IS NOT NULL', () => {
    expect(SQL).toMatch(
      /UPDATE\s+public\.quality_issues\s+SET\s+original_ai_fix_options\s*=\s*ai_fix_options\s+WHERE\s+ai_fix_options\s+IS\s+NOT\s+NULL/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Group F: llm_calls thinking-block additions
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — llm_calls thinking-block additions', () => {
  it('§F.1 — adds thinking JSONB and thinking_token_count INT (both nullable)', () => {
    const block = SQL.match(/ALTER\s+TABLE\s+public\.llm_calls\s+([\s\S]+?);/i)
    expect(block).not.toBeNull()
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+thinking\s+JSONB/i,
    )
    expect(block![1]).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+thinking_token_count\s+INT/i,
    )
    // Must be nullable — Phase 2 wires extended thinking, leaving these
    // columns NULL on every existing call until then.
    expect(block![1]).not.toMatch(/thinking\s+JSONB\s+NOT\s+NULL/i)
    expect(block![1]).not.toMatch(/thinking_token_count\s+INT\s+NOT\s+NULL/i)
  })

  it('§F.2 — partial index on llm_calls(created_at DESC) WHERE thinking IS NOT NULL', () => {
    expect(SQL).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_llm_calls_with_thinking\s+ON\s+public\.llm_calls\s*\(\s*created_at\s+DESC\s*\)\s+WHERE\s+thinking\s+IS\s+NOT\s+NULL/i,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Defensive: deferred-out-of-scope items must NOT have crept in
// ──────────────────────────────────────────────────────────────────────────

describe('migration 083 — deferred items are NOT present', () => {
  it('does NOT create the migration_intelligence_increment RPC (deferred per stop-and-report)', () => {
    expect(SQL).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?migration_intelligence_increment/i,
    )
  })

  it('does NOT add pattern_type or pattern_signature columns to migration_intelligence', () => {
    expect(SQL).not.toMatch(
      /ALTER\s+TABLE\s+(public\.)?migration_intelligence[\s\S]+?pattern_type/i,
    )
    expect(SQL).not.toMatch(
      /ALTER\s+TABLE\s+(public\.)?migration_intelligence[\s\S]+?pattern_signature/i,
    )
  })

  it('does NOT add a parent_edit_id column to ai_edit_history', () => {
    // Allow the word in comments (the migration explains why it is excluded);
    // forbid it appearing as an actual column declaration.
    expect(SQL).not.toMatch(/^\s*parent_edit_id\s+UUID/im)
    expect(SQL).not.toMatch(/ADD\s+COLUMN[^;]*parent_edit_id/i)
  })
})
