/**
 * Platform admin authorization helpers.
 *
 * Platform admins are users who can manage Settle itself (not individual
 * orgs). They can approve access requests, create org invites across any
 * org, and access the /admin route tree. The set of platform admins is
 * stored in public.platform_admins and checked via the
 * public.is_platform_admin(UUID) SECURITY DEFINER function added in
 * migration 068.
 *
 * Two helpers are exported:
 *
 *   isPlatformAdmin(userId)      — boolean check by UUID.
 *   requirePlatformAdmin()        — wraps session lookup + check, returns
 *                                   a result object matching the
 *                                   {ok, error} pattern used elsewhere in
 *                                   lib/actions (no throwing).
 *
 * Both call the database via supabaseAdmin (service_role) so the caller
 * does not need to fetch the user's role themselves. The RPC result is
 * fail-closed: any error treats the user as NOT an admin.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Check whether the given user_id is a platform admin.
 * Returns false on any error (fail-closed).
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('is_platform_admin', {
    check_user_id: userId,
  })

  if (error) {
    console.error('[platform-admin] is_platform_admin RPC failed:', error)
    return false
  }

  return data === true
}

/**
 * Result of a platform-admin authorization check.
 *
 * Matches the {ok, error} shape used by lib/actions/role-resolution.ts
 * requireProjectPermission() so call sites can pattern-match uniformly
 * across authorization helpers.
 */
export type RequirePlatformAdminResult =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; error: string }

/**
 * Look up the current session user and confirm they are a platform admin.
 * Intended for use in server actions and Server Components.
 *
 * Returns { ok: true, userId, email } on success.
 * Returns { ok: false, error } on any failure (no auth, not an admin,
 * or RPC failure). Never throws.
 *
 * Callers should pattern-match on `ok` and return their existing
 * error shape to preserve the contract of the enclosing action.
 */
export async function requirePlatformAdmin(): Promise<RequirePlatformAdminResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, error: 'Not authenticated' }
  }

  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return { ok: false, error: 'Not a platform admin' }
  }

  return { ok: true, userId: user.id, email: user.email ?? null }
}
