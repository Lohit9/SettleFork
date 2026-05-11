'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'

/**
 * Admin-only server actions for flipping the Rootstock POC flag on
 * `public.projects`. Three operations: set `poc_template`, set
 * `poc_overrides`, and clear both atomically.
 *
 * Permission: `admin` — mirrors the `setProjectMappingRedesign` precedent
 * (`lib/actions/admin-mapping-flag.ts`). Flipping a project into the POC
 * answer-key codepath is a reversible-but-impactful top-level state
 * mutation; same risk profile as `deleteProject` (admin) and the existing
 * mapping-redesign flip.
 *
 * No UI surface yet — operators invoke these from a one-shot script or
 * directly from Supabase SQL. A future PR could add an admin panel; not
 * scoped for the POC.
 *
 * Sunset: INF-73 (single removal PR after iter-3 ships generic
 * multi-entity authoring + answer-key-style decision/lookup output as
 * default behavior). The whole file goes away.
 */

export interface AdminPocFlagResult {
  success: boolean
  allowed: boolean
  error?: string
}

/**
 * Set or clear the `poc_template` discriminator. Pass `null` to clear;
 * pass a non-empty string (today only `'rootstock'`) to enable POC mode.
 *
 * Does NOT touch `poc_overrides` — call `setPocOverrides` separately or
 * `clearPocFlag` to reset both atomically.
 */
export async function setPocTemplate(
  projectId: string,
  template: string | null,
): Promise<AdminPocFlagResult> {
  const perm = await requireProjectPermission(projectId, 'admin')
  if (!perm.allowed) {
    return { success: false, allowed: false, error: perm.error }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('projects')
    .update({ poc_template: template })
    .eq('id', projectId)

  if (error) {
    console.error(
      `[admin-poc-flag] setPocTemplate failed for project=${projectId}: ${error.message}`,
    )
    return { success: false, allowed: true, error: error.message }
  }

  // Path D's BUILD-AI-CONTEXT reads `poc_template` from the projects
  // row on every run, so this flip takes effect on the next mapping
  // generation. Revalidate the project layout to refresh any UI that
  // surfaces the flag state.
  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, allowed: true }
}

/**
 * Replace the `poc_overrides` JSONB map. The new value is the authoritative
 * substitution map for the next `applyPocOverrides` pass — pass `{}` to
 * clear all overrides, or a `Record<string, unknown>` keyed by the
 * `{{token}}` names that appear in the project's answer-key markdown.
 *
 * Caller is responsible for verifying the override keys exist in the
 * answer key; missing keys leave their `{{token}}` literal in the
 * rendered prompt (see `applyPocOverrides` POC4 invariant) which is
 * recoverable but visible in `llm_calls.user_message`.
 */
export async function setPocOverrides(
  projectId: string,
  overrides: Record<string, unknown>,
): Promise<AdminPocFlagResult> {
  const perm = await requireProjectPermission(projectId, 'admin')
  if (!perm.allowed) {
    return { success: false, allowed: false, error: perm.error }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('projects')
    .update({ poc_overrides: overrides })
    .eq('id', projectId)

  if (error) {
    console.error(
      `[admin-poc-flag] setPocOverrides failed for project=${projectId}: ${error.message}`,
    )
    return { success: false, allowed: true, error: error.message }
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, allowed: true }
}

/**
 * Atomic clear: set `poc_template` to NULL and `poc_overrides` to `{}`.
 * Used to roll a project back to heritage Path D behavior. Equivalent
 * to `setPocTemplate(id, null)` + `setPocOverrides(id, {})` but in a
 * single UPDATE, which avoids a brief window where the template is
 * cleared but overrides linger.
 */
export async function clearPocFlag(
  projectId: string,
): Promise<AdminPocFlagResult> {
  const perm = await requireProjectPermission(projectId, 'admin')
  if (!perm.allowed) {
    return { success: false, allowed: false, error: perm.error }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('projects')
    .update({ poc_template: null, poc_overrides: {} })
    .eq('id', projectId)

  if (error) {
    console.error(
      `[admin-poc-flag] clearPocFlag failed for project=${projectId}: ${error.message}`,
    )
    return { success: false, allowed: true, error: error.message }
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, allowed: true }
}
