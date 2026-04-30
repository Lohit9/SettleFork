'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'

/**
 * Admin-only server actions for flipping the mapping-redesign feature flags
 * on `public.projects`. Used by the founder / operators during the canary
 * rollout and the Phase 1+2 deployment window.
 *
 * Permission: `admin` — matches the `deleteProject` precedent. The reasoning
 * is that flipping a project into the new UI (or into maintenance mode) is
 * a cheaper, reversible version of the "mutate project top-level state"
 * capability that `admin` already has via delete.
 *
 * Return shape: `{ allowed, error? }` on permission failures; `{ success,
 * error? }` on DB failures. Matches the mixed style used elsewhere in
 * lib/actions/.
 *
 * See docs/features/mapping-redesign.md §"Feature flag infrastructure"
 * §"Canary rollout sequence" for the operational playbook.
 */

export interface AdminFlagResult {
  success: boolean
  allowed: boolean
  error?: string
}

export async function setProjectMappingRedesign(
  projectId: string,
  enabled: boolean
): Promise<AdminFlagResult> {
  const perm = await requireProjectPermission(projectId, 'admin')
  if (!perm.allowed) {
    return { success: false, allowed: false, error: perm.error }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('projects')
    .update({ use_mapping_redesign: enabled })
    .eq('id', projectId)

  if (error) {
    return { success: false, allowed: true, error: error.message }
  }

  // Redesign toggle is read by the mapping page's server-side dispatch
  // (mapping/page.tsx). Revalidate the project's layout so the new flag
  // value is picked up on next navigation.
  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, allowed: true }
}

export async function setProjectMaintenanceMode(
  projectId: string,
  enabled: boolean
): Promise<AdminFlagResult> {
  const perm = await requireProjectPermission(projectId, 'admin')
  if (!perm.allowed) {
    return { success: false, allowed: false, error: perm.error }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('projects')
    .update({ maintenance_mode: enabled })
    .eq('id', projectId)

  if (error) {
    return { success: false, allowed: true, error: error.message }
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, allowed: true }
}
