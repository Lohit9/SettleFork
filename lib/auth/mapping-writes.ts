import 'server-only'

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Server-side guard that blocks mapping writes during the deployment-window
 * maintenance period. Call at the top of every mapping write-path server
 * action (create/update/approve/reject/delete of mappings, transformations
 * bound to mappings, FK cascade, etc.) before performing any state change.
 *
 * Throws a user-readable error when `projects.maintenance_mode = true`.
 * Does NOT check `use_mapping_redesign` — that flag is a UI rollout gate,
 * not a write-path gate. See docs/features/mapping-redesign.md §"Feature
 * flag infrastructure" Use 1 (maintenance_mode) vs Use 2 (use_mapping_redesign).
 *
 * Uses the service-role client so the read cannot be blocked by RLS and
 * stays fast — we only care about the maintenance flag, not user auth.
 * Caller is responsible for permission checks via requireProjectPermission.
 */
export async function assertMappingWritesEnabled(projectId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('maintenance_mode')
    .eq('id', projectId)
    .single()

  // Fail-closed on unexpected errors (e.g. project not found). A write against
  // a nonexistent project would fail downstream anyway, but a clear error here
  // is friendlier than a cryptic FK violation.
  if (error || !data) {
    throw new Error('Project not found or unavailable')
  }

  if (data.maintenance_mode === true) {
    throw new Error('Mapping writes are temporarily disabled for scheduled maintenance')
  }
}
