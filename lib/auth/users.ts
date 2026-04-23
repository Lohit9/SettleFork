/**
 * Auth user lookup helpers.
 *
 * Thin, typed wrappers over the SECURITY DEFINER RPCs defined in
 * migration 069_auth_user_lookup_rpcs.sql. These replace the previous
 * pattern of:
 *
 *   supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
 *     .then(r => r.users.find(u => u.email === email))
 *
 * which was O(all users) per call and had a silent correctness
 * ceiling at 1000 users.
 *
 * Three helpers are exported:
 *
 *   findAuthUserByEmail(email) — single-user email lookup.
 *   authUserExistsByEmail(email) — boolean existence check.
 *   getAuthEmailsByIds(ids) — batch id -> email resolver.
 *
 * All three call the database via supabaseAdmin (service_role). User
 * sessions cannot invoke the underlying RPCs — they are granted
 * EXECUTE only to service_role.
 *
 * All three fail closed on error: they log the error and return a
 * null / empty-map / false result. Callers should not assume an
 * exception would have been thrown; check the return value.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Reference to an auth.users row. Contains only the fields exposed
 * by the find_auth_user_by_email / get_auth_emails_by_ids RPCs —
 * no access to password hashes, MFA factors, or other sensitive
 * fields.
 */
export interface AuthUserRef {
  id: string
  email: string | null
}

/**
 * Find an auth user by email (case-insensitive).
 *
 * Returns the first match if multiple rows exist. In the steady
 * state (post-SSO dedupe), there should only ever be one row per
 * email; if future SSO identity work allows email collisions
 * intentionally, this helper's contract may need revisiting.
 *
 * Returns null if no match, or if the RPC errors (fail-closed).
 */
export async function findAuthUserByEmail(
  email: string
): Promise<AuthUserRef | null> {
  if (!email) return null

  const { data, error } = await supabaseAdmin.rpc(
    'find_auth_user_by_email',
    { p_email: email }
  )

  if (error) {
    console.error('[auth/users] find_auth_user_by_email RPC failed:', error)
    return null
  }

  if (!Array.isArray(data) || data.length === 0) return null

  const row = data[0]
  return { id: row.id, email: row.email ?? null }
}

/**
 * Check whether an auth user exists for the given email
 * (case-insensitive). Thin wrapper over findAuthUserByEmail for
 * readability at boolean-only call sites.
 *
 * Returns false if no match OR if the lookup errors (fail-closed).
 * Callers that need to distinguish "definitely does not exist"
 * from "we could not check" should call findAuthUserByEmail
 * directly.
 */
export async function authUserExistsByEmail(email: string): Promise<boolean> {
  const user = await findAuthUserByEmail(email)
  return user !== null
}

/**
 * Batch-resolve a set of user IDs to their emails. Returns a Map
 * for O(1) lookup at call sites (used by org-member listings that
 * need to join memberships -> emails without a full-table scan).
 *
 * IDs not present in auth.users are simply absent from the
 * returned Map. An empty or null input array yields an empty Map
 * (no RPC call is made).
 *
 * Returns an empty Map on RPC error (fail-closed).
 */
export async function getAuthEmailsByIds(
  ids: string[]
): Promise<Map<string, string | null>> {
  if (!ids || ids.length === 0) return new Map()

  const { data, error } = await supabaseAdmin.rpc(
    'get_auth_emails_by_ids',
    { p_user_ids: ids }
  )

  if (error) {
    console.error('[auth/users] get_auth_emails_by_ids RPC failed:', error)
    return new Map()
  }

  if (!Array.isArray(data)) return new Map()

  const result = new Map<string, string | null>()
  for (const row of data) {
    if (row?.id) result.set(row.id, row.email ?? null)
  }
  return result
}
