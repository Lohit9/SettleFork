/**
 * Path D pre-execution gate — shared between `generateMappings` (server
 * action) and the SSE route handler (Sub-PR 5).
 *
 * Both callsites need to verify the same two conditions before opening
 * an Anthropic stream:
 *
 *   1. `AI_MAPPING_PATH_D_ENABLED='1'` — the Path D feature flag.
 *      When unset, calls fail with code='FLAG_OFF'. Production currently
 *      keeps the flag unset; flipping it to '1' is the operational
 *      handoff for adopting Path D.
 *
 *   2. The project's target-field count is at or below
 *      `PATH_D_MONOLITHIC_THRESHOLD` (350 by default; per-deployment
 *      override via `AI_MAPPING_PATH_D_MONOLITHIC_THRESHOLD`). Above
 *      threshold, monolithic Path D is architecturally infeasible
 *      (output would exceed `PATH_D_MAX_OUTPUT_TOKENS`); Phase C
 *      sharding will lift this limit.
 *
 * Result shape mirrors the {ok, ...} convention used by sibling auth
 * helpers (`requireProjectPermission`, `requirePlatformAdmin`) so call
 * sites pattern-match uniformly.
 *
 * NOTE on env-var read timing: Both checks read `process.env` at call
 * time, not at module-load time — this matters for the SSE route
 * handler which may be loaded before env vars are populated and
 * remains warm across requests with potentially-changing config.
 *
 * @see lib/actions/mappings.ts:generateMappings — the original callsite
 *      (now delegates to this helper)
 * @see lib/ai/path-d-stream-handler.ts — the new SSE callsite
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PATH_D_MONOLITHIC_THRESHOLD,
  ProjectTooLargeError,
} from '@/lib/ai/path-d-config'

/**
 * Discriminated outcome of the precondition gate.
 *
 *   `ok: true` — flag is on, target field count is within threshold,
 *   caller can proceed to open the orchestrator.
 *
 *   `ok: false` with code='FLAG_OFF' — `AI_MAPPING_PATH_D_ENABLED`
 *   is not '1'. Caller should fall back to Path B (server action) or
 *   surface the message verbatim (SSE route).
 *
 *   `ok: false` with code='OVER_THRESHOLD' — target field count
 *   exceeds the monolithic threshold. Carries the actual count for
 *   diagnostic surfacing. Message text is the canonical
 *   `ProjectTooLargeError` message.
 */
export type PathDPreconditionResult =
  | { ok: true }
  | {
      ok: false
      code: 'FLAG_OFF' | 'OVER_THRESHOLD'
      error: string
      targetFieldCount?: number
    }

export interface CheckPathDPreconditionsArgs {
  /**
   * Target table IDs the caller is about to map. The helper counts
   * fields under these tables and compares to the threshold. Passing
   * an empty array short-circuits to `ok: true` (the orchestrator's
   * own validation will catch the empty-tables case).
   */
  targetTableIds: string[]
  /**
   * Service-role admin client for the target-field count query. Caller
   * passes their own admin so the query runs against whatever env the
   * caller is configured for (production callers pass `supabaseAdmin`;
   * tests pass a chain-tracker mock).
   */
  admin: SupabaseClient
}

export async function checkPathDPreconditions(
  args: CheckPathDPreconditionsArgs,
): Promise<PathDPreconditionResult> {
  // 1. Flag check. Read env at call time — see file-header note.
  if (process.env.AI_MAPPING_PATH_D_ENABLED !== '1') {
    return {
      ok: false,
      code: 'FLAG_OFF',
      error: 'Path D is not enabled (AI_MAPPING_PATH_D_ENABLED unset).',
    }
  }

  // 2. Threshold check. Counts fields under the supplied target tables.
  // Empty input short-circuits to ok=true; the orchestrator's own
  // validation surfaces the empty-tables error to the user.
  if (args.targetTableIds.length === 0) {
    return { ok: true }
  }

  const { count: targetFieldCount } = await args.admin
    .from('fields')
    .select('id', { count: 'exact', head: true })
    .in('table_id', args.targetTableIds)

  const actualCount = targetFieldCount ?? 0
  if (actualCount > PATH_D_MONOLITHIC_THRESHOLD) {
    return {
      ok: false,
      code: 'OVER_THRESHOLD',
      error: new ProjectTooLargeError(actualCount).message,
      targetFieldCount: actualCount,
    }
  }

  return { ok: true }
}
