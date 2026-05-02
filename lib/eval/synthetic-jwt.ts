/**
 * Phase 1 PR 10.4 — synthetic JWT for the eval CLI.
 *
 * Why this exists:
 *
 *   The eval runner inserts synthetic projects, runs the production
 *   mapping AI entry point, and reads results back. Several deep
 *   layers of the production code path call SECURITY DEFINER RPCs
 *   that gate on `auth.uid()` (e.g. `dq_create_target_field_mapping`
 *   checks `user_has_project_role(p, 'editor')`, which reads
 *   auth.uid()).
 *
 *   When the eval runner uses the service-role client (`supabaseAdmin`),
 *   `auth.uid()` is NULL — service-role bypasses RLS but doesn't
 *   impersonate any user. So those RPC checks fail.
 *
 *   The fix: produce a JWT signed with `SUPABASE_JWT_SECRET` whose
 *   `sub` claim is `EVAL_USER_ID`. Hand the JWT to a regular
 *   `@supabase/supabase-js` client via the Authorization header.
 *   Now `auth.uid()` returns `EVAL_USER_ID` and the project_members
 *   row inserted by `createSyntheticProject` (PR 10.4) satisfies the
 *   user_has_project_role check.
 *
 *   This is eval-only code. Production never signs JWTs manually —
 *   real users sign in via Supabase Auth and the JWT comes back from
 *   the auth server. This module exists so the CLI can drive the
 *   same code path production users drive.
 *
 * Why node:crypto and not jsonwebtoken:
 *
 *   `jsonwebtoken` isn't in this repo's dependencies. JWT for HS256
 *   is small enough to implement directly with node:crypto's HMAC
 *   primitive (~30 LOC). The Supabase JWT shape is documented at
 *   https://supabase.com/docs/guides/auth/jwts.
 */

import { createHmac } from 'node:crypto'

/** Required env vars for synthetic JWT signing. */
const REQUIRED_ENV = ['SUPABASE_JWT_SECRET', 'EVAL_USER_ID'] as const

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Sign a JWT for the synthetic eval user. Valid for 1 hour. Throws
 * with a clear error if any required env var is missing.
 */
export function signSyntheticJwt(): string {
  for (const name of REQUIRED_ENV) {
    const v = process.env[name]
    if (!v || v.length === 0) {
      throw new Error(
        `[eval/synthetic-jwt] Required env var "${name}" is not set. Add it to .env.local before running the eval CLI.`,
      )
    }
  }
  const secret = process.env.SUPABASE_JWT_SECRET!
  const sub = process.env.EVAL_USER_ID!

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub,
    aud: 'authenticated',
    role: 'authenticated',
    iat: now,
    exp: now + 60 * 60, // 1 hour
  }

  const encodedHeader = base64Url(JSON.stringify(header))
  const encodedPayload = base64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = base64Url(
    createHmac('sha256', secret).update(signingInput).digest(),
  )
  return `${signingInput}.${signature}`
}
