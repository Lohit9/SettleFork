'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { assertNoDml, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'

// ── Input validation framework ─────────────────────────────────────────────
//
// Zod is the codebase's input-validation framework (CLAUDE.md §9.3).
// `lib/actions/projects.ts` is the canonical adopter; this file mirrors the
// pattern: module-level constants, module-level z.object schemas, .safeParse
// inside each action body returning the first issue via the standard
// { success: false, error } shape.

const PARTITION_LABEL_MAX_LENGTH = 64
const FILTER_SQL_MAX_LENGTH = 8000

const labelSchema = z
  .string()
  .trim()
  .min(2, 'Partition label must be at least 2 characters')
  .max(PARTITION_LABEL_MAX_LENGTH, `Partition label must be ${PARTITION_LABEL_MAX_LENGTH} characters or less`)

const filterSqlSchema = z
  .string()
  .trim()
  .min(1, 'Filter SQL cannot be empty')
  .max(FILTER_SQL_MAX_LENGTH, `Filter SQL must be ${FILTER_SQL_MAX_LENGTH} characters or less`)

const ordinalSchema = z.number().int().min(0)

const dedupPrioritySchema = z.number().int().min(0)

const uuidSchema = z.string().uuid()

const createPartitionInputSchema = z.object({
  projectId: uuidSchema,
  sourceTableId: uuidSchema,
  targetTableId: uuidSchema,
  filterSql: filterSqlSchema.nullable().optional(),
  partitionLabel: labelSchema.nullable().optional(),
  partitionOrdinal: ordinalSchema.nullable().optional(),
  identityFieldId: uuidSchema.nullable().optional(),
  dedupPriority: dedupPrioritySchema.nullable().optional(),
})

const updateFilterInputSchema = z.object({
  tableMappingId: uuidSchema,
  filterSql: filterSqlSchema.nullable(),
})

const updateMetadataInputSchema = z.object({
  tableMappingId: uuidSchema,
  partitionLabel: labelSchema.nullable().optional(),
  partitionOrdinal: ordinalSchema.nullable().optional(),
  identityFieldId: uuidSchema.nullable().optional(),
  dedupPriority: dedupPrioritySchema.nullable().optional(),
})

const testFilterInputSchema = z.object({
  projectId: uuidSchema,
  sourceTableId: uuidSchema,
  filterSql: filterSqlSchema,
})

// ── Return-type taxonomy ───────────────────────────────────────────────────

export type PartitionWriteErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_AUTHENTICATED'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'HAS_STAGED_ROWS'
  | 'INTERNAL'

interface PartitionWriteResult {
  success: boolean
  error?: string
  errorCode?: PartitionWriteErrorCode
}

// ── createPartition ────────────────────────────────────────────────────────
//
// Inserts a new table_mappings row representing a partition of (source_table,
// target_table) within projectId. Status defaults to 'approved' (manually
// created — user explicitly intended this partition).
//
// Validation order (fail-fast):
//   1. Auth
//   2. Zod input shape
//   3. Project-level editor permission
//   4. Both tables belong to projectId
//   5. partition_label unique per (project_id, target_table_id) if non-null
//   6. identity_field_id matches sibling partitions if any have one set
//   7. filter_sql passes assertNoDml (client-side DML guard)
//
// On success: returns { success: true, tableMappingId }. UI calls
// revalidatePath on the mapping route to refresh tabs.

export async function createPartition(input: {
  projectId: string
  sourceTableId: string
  targetTableId: string
  filterSql?: string | null
  partitionLabel?: string | null
  partitionOrdinal?: number | null
  identityFieldId?: string | null
  dedupPriority?: number | null
}): Promise<PartitionWriteResult & { tableMappingId?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated', errorCode: 'NOT_AUTHENTICATED' }
  }

  const parsed = createPartitionInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input',
      errorCode: 'VALIDATION',
    }
  }
  const {
    projectId,
    sourceTableId,
    targetTableId,
    filterSql,
    partitionLabel,
    partitionOrdinal,
    identityFieldId,
    dedupPriority,
  } = parsed.data

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }
  }

  // Both tables must belong to projectId.
  const { data: tables, error: tablesErr } = await supabaseAdmin
    .from('tables')
    .select('id, dataset_id, datasets!inner(project_id)')
    .in('id', [sourceTableId, targetTableId])
  if (tablesErr) {
    return { success: false, error: tablesErr.message, errorCode: 'INTERNAL' }
  }
  if (!tables || tables.length !== 2) {
    return {
      success: false,
      error: 'Source or target table not found',
      errorCode: 'NOT_FOUND',
    }
  }
  // datasets!inner returns the joined dataset row (or array — depends on supabase
  // client behavior); coerce to a project_id check.
  for (const t of tables) {
    const ds = Array.isArray(t.datasets) ? t.datasets[0] : t.datasets
    if (!ds || (ds as { project_id: string }).project_id !== projectId) {
      return {
        success: false,
        error: `Table ${t.id} does not belong to project ${projectId}`,
        errorCode: 'VALIDATION',
      }
    }
  }

  // partition_label uniqueness per (project, target_table).
  if (partitionLabel != null) {
    const { data: existing } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', projectId)
      .eq('target_table_id', targetTableId)
      .eq('partition_label', partitionLabel)
      .maybeSingle()
    if (existing) {
      return {
        success: false,
        error: `Partition label "${partitionLabel}" is already used for this target table`,
        errorCode: 'VALIDATION',
      }
    }
  }

  // identity_field consistency with siblings.
  if (identityFieldId != null) {
    const { data: siblings } = await supabaseAdmin
      .from('table_mappings')
      .select('id, identity_field_id')
      .eq('project_id', projectId)
      .eq('target_table_id', targetTableId)
    const conflict = (siblings ?? []).find(
      (s) => s.identity_field_id != null && s.identity_field_id !== identityFieldId,
    )
    if (conflict) {
      return {
        success: false,
        error: `Identity field must match sibling partitions (${conflict.identity_field_id})`,
        errorCode: 'VALIDATION',
      }
    }
  }

  // Client-side filter_sql DML guard. RPC dq_test_filter_sql repeats the same
  // check; this is defense-in-depth + fast-fail before the DB write.
  if (filterSql != null) {
    try {
      assertNoDml(filterSql)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'invalid filter expression'
      return { success: false, error: `Partition filter: ${msg}`, errorCode: 'VALIDATION' }
    }
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('table_mappings')
    .insert({
      project_id: projectId,
      source_table_id: sourceTableId,
      target_table_id: targetTableId,
      confidence: null,
      status: 'approved',
      ai_reasoning: 'Manually created partition (PR Ω.3.1)',
      filter_sql: filterSql ?? null,
      partition_label: partitionLabel ?? null,
      partition_ordinal: partitionOrdinal ?? null,
      identity_field_id: identityFieldId ?? null,
      dedup_priority: dedupPriority ?? null,
    })
    .select('id')
    .single<{ id: string }>()

  if (insertErr || !inserted) {
    return {
      success: false,
      error: insertErr?.message ?? 'Failed to create partition',
      errorCode: 'INTERNAL',
    }
  }

  revalidatePath(`/app/projects/${projectId}/mapping`)
  return { success: true, tableMappingId: inserted.id }
}

// ── updatePartitionFilter ──────────────────────────────────────────────────
//
// Updates filter_sql on an existing partition. Returns the count of
// staged_data_rows affected by the partition; UI uses this to surface the
// clear-before-reapply prompt (design doc §6.4). Per design doc Q3 decision:
// system does NOT auto-clear — explicit user action required.

export async function updatePartitionFilter(input: {
  tableMappingId: string
  filterSql: string | null
}): Promise<PartitionWriteResult & { stagedRowsAffected?: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated', errorCode: 'NOT_AUTHENTICATED' }
  }

  const parsed = updateFilterInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input',
      errorCode: 'VALIDATION',
    }
  }
  const { tableMappingId, filterSql } = parsed.data

  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id')
    .eq('id', tableMappingId)
    .single<{ id: string; project_id: string }>()
  if (tmErr || !tm) {
    return {
      success: false,
      error: 'Partition not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) {
    return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }
  }

  if (filterSql != null) {
    try {
      assertNoDml(filterSql)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'invalid filter expression'
      return { success: false, error: `Partition filter: ${msg}`, errorCode: 'VALIDATION' }
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from('table_mappings')
    .update({ filter_sql: filterSql })
    .eq('id', tableMappingId)
  if (updErr) {
    return { success: false, error: updErr.message, errorCode: 'INTERNAL' }
  }

  // Count staged rows affected — UI uses this to decide whether to show the
  // clear-before-reapply prompt. Pre-existing rows from the OLD filter may
  // now be stale.
  const { count } = await supabaseAdmin
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tableMappingId)

  revalidatePath(`/app/projects/${tm.project_id}/mapping`)
  return { success: true, stagedRowsAffected: count ?? 0 }
}

// ── updatePartitionMetadata ────────────────────────────────────────────────
//
// Updates non-SQL metadata on a partition (label, ordinal, identity field,
// dedup priority). Each input field is optional; only provided fields are
// written. Same sibling-consistency rules as createPartition.

export async function updatePartitionMetadata(input: {
  tableMappingId: string
  partitionLabel?: string | null
  partitionOrdinal?: number | null
  identityFieldId?: string | null
  dedupPriority?: number | null
}): Promise<PartitionWriteResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated', errorCode: 'NOT_AUTHENTICATED' }
  }

  const parsed = updateMetadataInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input',
      errorCode: 'VALIDATION',
    }
  }
  const { tableMappingId, partitionLabel, partitionOrdinal, identityFieldId, dedupPriority } = parsed.data

  // Reject no-op calls — caller should pass at least one field.
  const anyFieldProvided =
    partitionLabel !== undefined ||
    partitionOrdinal !== undefined ||
    identityFieldId !== undefined ||
    dedupPriority !== undefined
  if (!anyFieldProvided) {
    return {
      success: false,
      error: 'No metadata fields provided',
      errorCode: 'VALIDATION',
    }
  }

  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, target_table_id')
    .eq('id', tableMappingId)
    .single<{ id: string; project_id: string; target_table_id: string }>()
  if (tmErr || !tm) {
    return { success: false, error: 'Partition not found', errorCode: 'NOT_FOUND' }
  }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) {
    return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }
  }

  // partition_label uniqueness (when changing to non-null).
  if (partitionLabel != null) {
    const { data: existing } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', tm.project_id)
      .eq('target_table_id', tm.target_table_id)
      .eq('partition_label', partitionLabel)
      .neq('id', tableMappingId)
      .maybeSingle()
    if (existing) {
      return {
        success: false,
        error: `Partition label "${partitionLabel}" is already used for this target table`,
        errorCode: 'VALIDATION',
      }
    }
  }

  // identity_field consistency (when changing to non-null).
  if (identityFieldId != null) {
    const { data: siblings } = await supabaseAdmin
      .from('table_mappings')
      .select('id, identity_field_id')
      .eq('project_id', tm.project_id)
      .eq('target_table_id', tm.target_table_id)
      .neq('id', tableMappingId)
    const conflict = (siblings ?? []).find(
      (s) => s.identity_field_id != null && s.identity_field_id !== identityFieldId,
    )
    if (conflict) {
      return {
        success: false,
        error: `Identity field must match sibling partitions (${conflict.identity_field_id})`,
        errorCode: 'VALIDATION',
      }
    }
  }

  // Build the partial UPDATE payload — only explicitly-provided fields are
  // written. Distinguish "undefined" (don't update) from "null" (set to NULL).
  const updates: Record<string, unknown> = {}
  if (partitionLabel !== undefined) updates.partition_label = partitionLabel
  if (partitionOrdinal !== undefined) updates.partition_ordinal = partitionOrdinal
  if (identityFieldId !== undefined) updates.identity_field_id = identityFieldId
  if (dedupPriority !== undefined) updates.dedup_priority = dedupPriority

  const { error: updErr } = await supabaseAdmin
    .from('table_mappings')
    .update(updates)
    .eq('id', tableMappingId)
  if (updErr) {
    return { success: false, error: updErr.message, errorCode: 'INTERNAL' }
  }

  revalidatePath(`/app/projects/${tm.project_id}/mapping`)
  return { success: true }
}

// ── deletePartition ────────────────────────────────────────────────────────
//
// Deletes a partition. Cascades via FK ON DELETE CASCADE to target_field_mappings
// (which cascades to mapping_sources + transformations) AND to staged_data_rows.
//
// Safety: if the partition has staged_data_rows, returns errorCode='HAS_STAGED_ROWS'
// with the row count. UI prompts the user to confirm; user re-calls with
// `force: true` to proceed. Per design doc §6.3 destructive-action UX.

export async function deletePartition(input: {
  tableMappingId: string
  force?: boolean
}): Promise<PartitionWriteResult & { stagedRowsBlocking?: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated', errorCode: 'NOT_AUTHENTICATED' }
  }

  if (!input.tableMappingId || typeof input.tableMappingId !== 'string') {
    return {
      success: false,
      error: 'tableMappingId is required',
      errorCode: 'VALIDATION',
    }
  }

  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id')
    .eq('id', input.tableMappingId)
    .single<{ id: string; project_id: string }>()
  if (tmErr || !tm) {
    return { success: false, error: 'Partition not found', errorCode: 'NOT_FOUND' }
  }

  const perm = await requireProjectPermission(tm.project_id, 'editor')
  if (!perm.allowed) {
    return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }
  }

  // Block on staged_data_rows unless force=true.
  if (!input.force) {
    const { count } = await supabaseAdmin
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', input.tableMappingId)
    if ((count ?? 0) > 0) {
      return {
        success: false,
        error: `Partition has ${count} staged row${count === 1 ? '' : 's'}. Pass force=true to delete anyway.`,
        errorCode: 'HAS_STAGED_ROWS',
        stagedRowsBlocking: count ?? 0,
      }
    }
  }

  const { error: delErr } = await supabaseAdmin
    .from('table_mappings')
    .delete()
    .eq('id', input.tableMappingId)
  if (delErr) {
    return { success: false, error: delErr.message, errorCode: 'INTERNAL' }
  }

  revalidatePath(`/app/projects/${tm.project_id}/mapping`)
  return { success: true }
}

// ── testFilterSql ──────────────────────────────────────────────────────────
//
// RUN-LIMIT-0 parse check for an unsaved partition filter. Used by
// PR Ω.3.2's PartitionRulesModal "Test filter" button to surface SQL
// errors before the user commits the partition.
//
// Flow:
//   1. Auth + Zod input
//   2. Project-level editor permission (RPC also re-asserts via SECURITY DEFINER)
//   3. Client-side assertNoDml (fast-fail, defense-in-depth)
//   4. Fetch source table's field names
//   5. Wrap filter via wrapFieldRefsInJsonb (string[] same-table overload —
//      produces unaliased `(row_data->>'X')` form that the RPC's
//      `data_rows`-no-alias query accepts)
//   6. Call dq_test_filter_sql RPC with the wrapped filter
//   7. Pass through the RPC's {ok, error?} JSONB shape, flattened into the
//      action's { success, error? } envelope
//
// Verbose error messages preserved per design doc Q7 (pilot decision).

export async function testFilterSql(input: {
  projectId: string
  sourceTableId: string
  filterSql: string
}): Promise<{ success: boolean; error?: string; errorCode?: PartitionWriteErrorCode }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: 'Not authenticated', errorCode: 'NOT_AUTHENTICATED' }
  }

  const parsed = testFilterInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input',
      errorCode: 'VALIDATION',
    }
  }
  const { projectId, sourceTableId, filterSql } = parsed.data

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }
  }

  try {
    assertNoDml(filterSql)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid filter expression'
    return { success: false, error: `Partition filter: ${msg}`, errorCode: 'VALIDATION' }
  }

  // Fetch source field names for wrapping. The string[] overload of
  // wrapFieldRefsInJsonb produces unaliased `(row_data->>'X')` refs, matching
  // dq_test_filter_sql's unaliased `data_rows` FROM clause.
  const { data: srcFields, error: fieldsErr } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  if (fieldsErr) {
    return { success: false, error: fieldsErr.message, errorCode: 'INTERNAL' }
  }
  const fieldNames = (srcFields ?? []).map((f) => f.name)

  let wrappedFilter: string
  try {
    wrappedFilter = wrapFieldRefsInJsonb(filterSql, fieldNames)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'filter qualification failed'
    return { success: false, error: `Partition filter: ${msg}`, errorCode: 'VALIDATION' }
  }

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('dq_test_filter_sql', {
    p_source_table_id: sourceTableId,
    p_filter_sql: wrappedFilter,
  })
  if (rpcErr) {
    return { success: false, error: rpcErr.message, errorCode: 'INTERNAL' }
  }

  const result = rpcResult as { ok: boolean; error?: string } | null
  if (!result || result.ok !== true) {
    return {
      success: false,
      error: result?.error ?? 'Filter SQL parse failed',
      errorCode: 'VALIDATION',
    }
  }

  return { success: true }
}
