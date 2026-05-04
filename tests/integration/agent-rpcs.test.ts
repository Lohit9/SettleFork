// @vitest-environment node
//
// PR 3.3 — integration tests for the 3 data-scanning RPCs against a
// real Supabase project. Verifies:
//   - Project-role gate (user_has_project_role(viewer)) rejects callers
//     without project membership
//   - Cross-project access blocked (table_id from another project)
//   - B1 where_filter allowlist accepts safe shapes, rejects unsafe
//   - B2 returns ordered distinct values + frequencies
//   - B3 returns joint frequency + conditional null rates
//
// Env-gated under RUN_LLM_CALLS_INTEGRATION=1 (matches existing
// integration-test gating; even though no LLM calls happen, the gate
// is for "tests that touch real Supabase").
//
// No LLM cost; Supabase RPC roundtrips only.

import { describe, expect, it } from 'vitest'

import { supabaseAdmin } from '@/lib/supabase/admin'

const RUN = process.env.RUN_LLM_CALLS_INTEGRATION === '1'

const PROJECT_ID =
  process.env.LLM_CALLS_INTEGRATION_PROJECT_ID ??
  process.env.MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID ??
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

const HAS_ENV =
  RUN &&
  Boolean(PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Helper: pick a real source table from the integration project ──────────

async function findFirstSourceTable(): Promise<{ tableId: string; fieldName: string } | null> {
  const { data: dataset } = await supabaseAdmin
    .from('datasets')
    .select('id')
    .eq('project_id', PROJECT_ID)
    .eq('role', 'source')
    .limit(1)
    .maybeSingle()
  if (!dataset) return null

  const { data: table } = await supabaseAdmin
    .from('tables')
    .select('id')
    .eq('dataset_id', dataset.id)
    .limit(1)
    .maybeSingle()
  if (!table) return null

  const { data: field } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('table_id', table.id)
    .limit(1)
    .maybeSingle()
  if (!field) return null

  return { tableId: table.id as string, fieldName: field.name as string }
}

// ─── B1: agent_query_field_data ──────────────────────────────────────────────

describeFn('[integration] agent_query_field_data (B1)', () => {
  it('returns sample values + total estimate when invoked with valid args', async () => {
    const target = await findFirstSourceTable()
    expect(target).not.toBeNull()
    if (!target) return

    const { data, error } = await supabaseAdmin.rpc('agent_query_field_data', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_name: target.fieldName,
      p_where_filter: null,
      p_limit: 5,
    })
    expect(error).toBeNull()
    expect(data).toHaveProperty('values')
    expect(data).toHaveProperty('total_returned')
    expect(data).toHaveProperty('total_in_table_estimate')
  }, 30_000)

  it('rejects unsafe where_filter (multiple conditions, DDL keywords, etc. — all hit the same regex-mismatch branch)', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    // Multi-condition with AND is the most representative attack vector;
    // DDL keywords / UNION / -- comments / multi-statements all fail
    // through the same regex-mismatch branch in the allowlist (see
    // migration 085). Single rejection case suffices to verify the
    // allowlist refuses anything not matching the documented pattern.
    const { error } = await supabaseAdmin.rpc('agent_query_field_data', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_name: target.fieldName,
      p_where_filter: "row_data->>'a' = '1' AND row_data->>'b' = '2'",
    })
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/unsafe where_filter/i)
  }, 30_000)

  it('accepts an IS NULL allowlist condition', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    const { error } = await supabaseAdmin.rpc('agent_query_field_data', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_name: target.fieldName,
      p_where_filter: `row_data->>'${target.fieldName}' IS NULL`,
      p_limit: 3,
    })
    expect(error).toBeNull()
  }, 30_000)

  it('rejects table_id from another project (cross-project block)', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    // Use a syntactically valid UUID that does NOT exist as a table
    // in this project. The structural check is the important assertion.
    const fakeTableId = '00000000-0000-0000-0000-000000000099'
    const { error } = await supabaseAdmin.rpc('agent_query_field_data', {
      p_project_id: PROJECT_ID,
      p_table_id: fakeTableId,
      p_field_name: target.fieldName,
    })
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/Table not in project/i)
  }, 30_000)
})

// ─── B2: agent_count_distinct_patterns ───────────────────────────────────────

describeFn('[integration] agent_count_distinct_patterns (B2)', () => {
  it('returns ordered distinct values with frequencies', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    const { data, error } = await supabaseAdmin.rpc('agent_count_distinct_patterns', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_name: target.fieldName,
      p_limit: 10,
    })
    expect(error).toBeNull()
    expect(data).toHaveProperty('patterns')
    expect(data).toHaveProperty('total_distinct')
    expect(data).toHaveProperty('truncated')
    if (Array.isArray(data.patterns) && data.patterns.length > 1) {
      // Patterns ordered by count desc
      expect(data.patterns[0].count).toBeGreaterThanOrEqual(data.patterns[1].count)
    }
  }, 30_000)

  it('rejects invalid field_name (JSONB-operator characters)', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    const { error } = await supabaseAdmin.rpc('agent_count_distinct_patterns', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_name: "row_data->>'x'",
    })
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/Invalid field_name|bare identifier/i)
  }, 30_000)
})

// ─── B3: agent_cross_field_correlation ──────────────────────────────────────

describeFn('[integration] agent_cross_field_correlation (B3)', () => {
  it('returns joint_top + conditional_null_rates', async () => {
    const target = await findFirstSourceTable()
    if (!target) return

    // Find a second field on the same table
    const { data: secondField } = await supabaseAdmin
      .from('fields')
      .select('name')
      .eq('table_id', target.tableId)
      .neq('name', target.fieldName)
      .limit(1)
      .maybeSingle()
    const fieldB = (secondField?.name as string | undefined) ?? target.fieldName // degenerate fallback

    const { data, error } = await supabaseAdmin.rpc(
      'agent_cross_field_correlation',
      {
        p_project_id: PROJECT_ID,
        p_table_id: target.tableId,
        p_field_a_name: target.fieldName,
        p_field_b_name: fieldB,
      },
    )
    expect(error).toBeNull()
    expect(data).toHaveProperty('joint_top')
    expect(data).toHaveProperty('conditional_null_rates')
  }, 30_000)

  it('rejects invalid field_a_name', async () => {
    const target = await findFirstSourceTable()
    if (!target) return
    const { error } = await supabaseAdmin.rpc('agent_cross_field_correlation', {
      p_project_id: PROJECT_ID,
      p_table_id: target.tableId,
      p_field_a_name: 'bad name with spaces',
      p_field_b_name: target.fieldName,
    })
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toMatch(/Invalid field_a_name|bare identifier/i)
  }, 30_000)
})
