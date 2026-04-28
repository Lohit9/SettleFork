import { createClient } from '@/lib/supabase/server'
import type { OrgRole } from '@/lib/types/organizations'

/**
 * Shared org-role authorization gate.
 *
 * Until B-2-c-i (this commit), the codebase had **no** reusable
 * primitive for "is the calling user an admin/owner of this specific
 * org?" Three call sites
 *   - `lib/actions/organizations.ts:108-117` (updateMemberRole)
 *   - `lib/actions/organizations.ts:158-166` (removeMember)
 *   - `lib/actions/org-invites.ts:25-34` (createOrgInvite)
 * each repeated the same five-line block:
 *
 *   const { data: callerMem } = await supabase
 *     .from('org_memberships')
 *     .select('role')
 *     .eq('org_id', orgId)
 *     .eq('user_id', user.id)
 *     .single()
 *   if (!callerMem || !['owner','admin'].includes(callerMem.role)) { ... }
 *
 * That pattern is fine for a single mutating action but is a footgun
 * when you start using `supabaseAdmin` (service role) for reads — RLS
 * is bypassed, so the app-level role check becomes the **only**
 * boundary preventing cross-tenant leakage. Centralizing the gate in
 * one place lets us:
 *   - audit it once (this file is the security boundary for B-2-c)
 *   - test it once (`tests/lib/auth/require-org-role.test.ts`)
 *   - return a structured result that callers can map to UX without
 *     swallowing the failure mode (membership vs. role vs. session)
 *
 * Identity sourcing — IMPORTANT
 * -----------------------------
 * The `userId` is derived from `supabase.auth.getUser()`, which reads
 * the verified Supabase session cookie. The `orgId` is supplied by
 * the caller — typically from a URL param or active-org cookie. The
 * helper VERIFIES that the session-user is a member of the
 * caller-supplied org with one of the allowed roles. Callers MUST
 * pass the orgId they are actually about to read/write; never derive
 * it inside the helper from a header or cookie that an attacker
 * could spoof.
 *
 * Self-membership read via SSR client
 * ------------------------------------
 * The membership lookup uses the SSR (RLS-bound) client deliberately.
 * Migration 051 (`051_fix_circular_rls.sql:46-48`) defines the
 * policy `members_can_view_fellow_members` which permits a member to
 * SELECT any membership row in an org they belong to — including
 * their own. Using the SSR client here means a stolen service-role
 * key cannot escalate this gate via crafted-cookie request; only a
 * valid signed session cookie passes the auth.uid() filter inside
 * RLS. If the policy is ever tightened such that self-read fails,
 * switch ONLY this internal lookup to `supabaseAdmin` — never the
 * downstream data reads in callers, which depend on the role check.
 *
 * Fail-closed: any DB error or absent membership row results in
 * `{ ok: false }`. The helper never throws.
 */
export type RequireOrgRoleResult =
  | { ok: true; userId: string; role: OrgRole }
  | {
      ok: false
      error: string
      code: 'unauthenticated' | 'not_member' | 'insufficient_role'
    }

/**
 * Verify the calling user is authenticated AND a member of `orgId`
 * with one of the `allowed` roles.
 *
 * @param orgId   The org being accessed. Must be the org the caller
 *                is about to read/write.
 * @param allowed Allowed roles. Use `['owner', 'admin']` for admin
 *                actions; use the convenience wrapper `requireOrgAdmin`
 *                for that common case.
 */
export async function requireOrgRole(
  orgId: string,
  allowed: readonly OrgRole[],
): Promise<RequireOrgRoleResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      ok: false,
      error: 'Not authenticated',
      code: 'unauthenticated',
    }
  }

  // RLS-bound self-read (see "Self-membership read via SSR client"
  // in the file-level docstring). `.maybeSingle()` (not `.single()`)
  // because a missing row is a normal "not a member" path, not an
  // error.
  const { data: membership, error } = await supabase
    .from('org_memberships')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    // Treat unexpected DB errors the same as "not a member" — never
    // leak the error detail to the caller; log for ops visibility.
    // This avoids a partial-disclosure side channel where an attacker
    // can distinguish "membership exists but query errored" from
    // "no membership".
    console.error(
      '[require-org-role] org_memberships lookup failed',
      { orgId, userId: user.id, error: error.message },
    )
    return {
      ok: false,
      error: 'Not a member of this organization',
      code: 'not_member',
    }
  }

  if (!membership) {
    return {
      ok: false,
      error: 'Not a member of this organization',
      code: 'not_member',
    }
  }

  const role = membership.role as OrgRole
  if (!allowed.includes(role)) {
    return {
      ok: false,
      error: `Role '${role}' is insufficient. Required: one of ${allowed.join(', ')}`,
      code: 'insufficient_role',
    }
  }

  return { ok: true, userId: user.id, role }
}

/**
 * Convenience wrapper: `requireOrgRole(orgId, ['owner', 'admin'])`.
 *
 * Use for any org-admin-only operation. The role allow-list mirrors
 * `get_user_admin_org_ids()` from migration 051 — keeping the
 * application gate and the database policy synchronized at a single
 * symbolic layer.
 */
export async function requireOrgAdmin(
  orgId: string,
): Promise<RequireOrgRoleResult> {
  return requireOrgRole(orgId, ['owner', 'admin'])
}
