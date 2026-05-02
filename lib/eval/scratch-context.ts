/**
 * Phase 1 PR 10.1 — synthetic project lifecycle for eval runs.
 *
 * The eval harness inserts synthetic projects into the production
 * Supabase to drive real production code paths through the AI entry
 * points (per the user's PR 10 architecture decision: prod Supabase,
 * three guards, no scratch instance until production users exist).
 *
 * Three load-bearing guards live here:
 *
 *   1. Hard prefix on synthetic project names. Every name MUST start
 *      with `EVAL_PROJECT_PREFIX`. The create + teardown helpers refuse
 *      operations on names that don't match.
 *
 *   2. Cleanup invariant. `sweepOrphans` removes any leftover synthetic
 *      projects from prior crashed runs. Eval CLI calls it at startup
 *      AND completion; a non-zero count at completion fails the run
 *      even if scoring otherwise succeeded.
 *
 *   3. Fail-closed teardown. `teardownSyntheticProject` reads the row
 *      first and refuses to delete unless the prefix matches. A typo
 *      in the runner that passes a real project id never deletes real
 *      data.
 *
 * Why ON DELETE CASCADE is sufficient for cleanup:
 *
 *   The `projects` table is the root tenant scope; every child table
 *   (target_field_mappings, mapping_sources, transformations,
 *   validation_rules, ai_edit_history, activity_log, llm_calls,
 *   datasets, tables, fields, …) declares
 *   `REFERENCES projects(id) ON DELETE CASCADE` directly or
 *   transitively. Deleting the project row cascades to every child
 *   in the same statement. No per-table teardown logic needed.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Naming guard: every synthetic project's name must start with this
 * prefix. The full name shape is `eval-synthetic-<uuid>` so leftovers
 * are easy to spot in the dashboard.
 */
export const EVAL_PROJECT_PREFIX = 'eval-synthetic-'

/**
 * Project insert columns the eval harness needs to set. The rest of
 * the columns either have defaults or are populated by triggers /
 * later RPCs that the eval runner exercises.
 */
export interface CreateSyntheticProjectInput {
  /** Must start with EVAL_PROJECT_PREFIX. */
  name: string
  /**
   * Owning user — required by RLS-driven downstream queries even when
   * the eval runner uses supabaseAdmin to bypass RLS for the insert.
   * Convention: a dedicated eval user provisioned out-of-band; pass
   * its UUID via env var `EVAL_USER_ID`.
   */
  userId: string
  /**
   * Owning org. Same provisioning expectation as `userId`. Pass via
   * env var `EVAL_ORG_ID`.
   */
  orgId: string
}

/**
 * Insert one synthetic project row and return its id.
 *
 * Throws if `input.name` doesn't start with EVAL_PROJECT_PREFIX. This
 * is the create-side prefix guard.
 */
export async function createSyntheticProject(
  input: CreateSyntheticProjectInput,
): Promise<string> {
  if (!input.name.startsWith(EVAL_PROJECT_PREFIX)) {
    throw new Error(
      `[eval/scratch-context] Synthetic project name MUST start with "${EVAL_PROJECT_PREFIX}". Got: "${input.name}"`,
    )
  }

  const { data, error } = await supabaseAdmin
    .from('projects')
    .insert({
      name: input.name,
      user_id: input.userId,
      org_id: input.orgId,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(
      `[eval/scratch-context] Failed to insert synthetic project "${input.name}": ${error?.message ?? 'no row returned'}`,
    )
  }

  const projectId = data.id as string

  // Phase 1 PR 10.4: project_members membership grant.
  //
  // Production projects are created via the `create_project_with_access`
  // RPC (migration 080) which fans out grants to project_members so the
  // creator + org admins/members can act on the project. The eval runner
  // bypasses that RPC by INSERTing directly into `projects` (because
  // create_project_with_access is itself behind cookies-based auth that
  // tsx can't satisfy). That leaves the synthetic project without any
  // project_members rows, which causes downstream RPCs like
  // `dq_create_target_field_mapping` to fail with
  // "permission denied for project ...".
  //
  // Insert the membership row directly. role='admin' so the synthetic
  // user satisfies every project_role check on the path
  // (admin > editor > viewer; see migration 079).
  const { error: memberErr } = await supabaseAdmin.from('project_members').insert({
    project_id: projectId,
    user_id: input.userId,
    role: 'admin',
  })
  if (memberErr) {
    // Best-effort cascade cleanup so we don't leave an orphan project
    // when the membership insert fails — the project is unusable
    // without it.
    await supabaseAdmin.from('projects').delete().eq('id', projectId)
    throw new Error(
      `[eval/scratch-context] Failed to insert project_members row for synthetic project "${input.name}": ${memberErr.message}`,
    )
  }

  return projectId
}

/**
 * Delete one synthetic project. The function reads the row first and
 * refuses to delete unless its name matches the prefix — a typo in the
 * runner that passes a real project id can never clobber real data.
 *
 * On success, returns true. On safety refusal, throws. On row-already-
 * gone (e.g. a parallel cleanup beat us), returns false.
 */
export async function teardownSyntheticProject(
  projectId: string,
): Promise<boolean> {
  // Read-before-delete: the prefix check happens against the row in
  // the database, not against an argument the caller could lie about.
  const { data: row, error: readErr } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle<{ id: string; name: string }>()

  if (readErr) {
    throw new Error(
      `[eval/scratch-context] Read-before-delete failed for project ${projectId}: ${readErr.message}`,
    )
  }

  if (!row) {
    // Already gone (concurrent cleanup or never existed). Not an error.
    return false
  }

  if (!row.name.startsWith(EVAL_PROJECT_PREFIX)) {
    throw new Error(
      `[eval/scratch-context] REFUSED to delete project "${row.name}" (id=${row.id}) — does not match eval prefix "${EVAL_PROJECT_PREFIX}". This is a safety guard; investigate the caller.`,
    )
  }

  const { error: delErr } = await supabaseAdmin
    .from('projects')
    .delete()
    .eq('id', projectId)

  if (delErr) {
    throw new Error(
      `[eval/scratch-context] Failed to delete synthetic project ${projectId}: ${delErr.message}`,
    )
  }

  return true
}

/**
 * Sweep ALL projects whose names match the eval prefix. Returns the
 * count swept. Eval CLI invokes this at startup (recovers from prior
 * crashes) AND at completion (must return zero, else the run fails).
 *
 * Each individual deletion still goes through teardownSyntheticProject,
 * so the prefix guard applies per-row even if the LIKE query somehow
 * returned a non-eval row (it cannot, but defense in depth).
 */
export async function sweepOrphans(): Promise<{
  swept: number
  ids: string[]
}> {
  const { data: orphans, error } = await supabaseAdmin
    .from('projects')
    .select('id, name')
    .like('name', `${EVAL_PROJECT_PREFIX}%`)

  if (error) {
    throw new Error(
      `[eval/scratch-context] Failed to query orphan projects: ${error.message}`,
    )
  }

  const rows = (orphans ?? []) as Array<{ id: string; name: string }>
  const ids: string[] = []

  for (const row of rows) {
    // Belt-and-braces: re-verify the prefix at the per-row level.
    if (!row.name.startsWith(EVAL_PROJECT_PREFIX)) {
      console.warn(
        `[eval/scratch-context] Skipping orphan sweep on "${row.name}" — LIKE matched but prefix check failed. This should be impossible.`,
      )
      continue
    }
    await teardownSyntheticProject(row.id)
    ids.push(row.id)
  }

  return { swept: ids.length, ids }
}
