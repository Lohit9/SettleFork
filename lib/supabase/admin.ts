import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Admin client bypasses RLS — use only for server-side admin operations.
// NEVER import this in any client component or any file with 'use client'.
//
// Lazy initialization (2026-04-30, chore/ci-test-secrets):
// ────────────────────────────────────────────────────────────────────────
// The service-role client used to be constructed at module-load time:
//
//   export const supabaseAdmin = createClient(URL!, SERVICE_KEY!)
//
// That broke the test workflow on GitHub Actions, where neither env var
// is set: any test that transitively imported this file (or a server
// action that imported it) crashed at COLLECTION time with
// "supabaseUrl is required" — before describe.skip gates could fire.
//
// The Proxy below defers construction to first property access. In
// production code paths the env vars are always present so the lazy
// init is invisible. In CI, tests that mock '@/lib/supabase/admin' or
// auto-skip via describe.skip never trigger getClient() at all, so the
// missing env vars never matter.
//
// IMPORTANT: the `value.bind(client)` step keeps `this` on method calls
// (`.from(...)`, `.auth.admin.createUser(...)`, etc.). Without it the
// underlying SDK throws on the first method call.

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (_client) return _client
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  return _client
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => {
    const client = getClient()
    const value = (client as unknown as Record<string | symbol, unknown>)[
      prop as string | symbol
    ]
    return typeof value === 'function' ? (value as Function).bind(client) : value
  },
})
