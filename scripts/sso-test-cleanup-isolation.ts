/**
 * SSO Cross-Tenant Isolation Fixture Cleanup (B-2-c-ii commit 1).
 *
 * Tears down the second-tenant fixture provisioned by
 * `sso-test-setup-isolation.ts`:
 *   - DELETE the User 2 row from auth.users (cascades memberships,
 *     identity_links, and any audit-event rows that referenced this
 *     user as actor).
 *   - DELETE the isolation organization (cascades any remaining
 *     org_memberships rows the auth.users CASCADE missed, plus any
 *     SSO-related rows if a future fixture extension adds them).
 *
 * Order matters: deleting the user first tightens the cascade tree
 * (auth.users → org_memberships → CASCADE) before the org delete
 * runs, so the org delete sees a clean slate.
 *
 * Idempotent: re-running is safe. Missing artifacts are no-ops.
 *
 * To run:
 *   npm run sso:test:cleanup:isolation
 *   (or directly: npx tsx scripts/sso-test-cleanup-isolation.ts)
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env.local from repo root
config({ path: resolve(process.cwd(), '.env.local') })

// ============================================================================
// Constants — must match sso-test-setup-isolation.ts
// ============================================================================

const ISO_ORG_SLUG = 'sso-isolation-test'
const ISO_USER_EMAIL = 'kaandincer1+ssoisolation@gmail.com'

// ============================================================================
// Env + client setup
// ============================================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    '❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local',
  )
  process.exit(1)
}

const SUPABASE_URL_STR: string = SUPABASE_URL
const SERVICE_KEY_STR: string = SERVICE_KEY

const supabase = createClient(SUPABASE_URL_STR, SERVICE_KEY_STR, {
  auth: { persistSession: false },
})

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' SSO Isolation Fixture Cleanup — B-2-c-ii commit 1')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Supabase project: ${SUPABASE_URL_STR}`)
  console.log(`  Iso org slug:     ${ISO_ORG_SLUG}`)
  console.log(`  Iso user email:   ${ISO_USER_EMAIL}`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 1: Find and delete User 2 (cascades memberships)
  // -------------------------------------------------------------------------
  console.log(`Step 1: Finding User 2 by email...`)
  const { data: foundUsers, error: findUserErr } = await supabase.rpc(
    'find_auth_user_by_email',
    { p_email: ISO_USER_EMAIL },
  )
  if (findUserErr) {
    console.error('❌ find_auth_user_by_email RPC failed:', findUserErr)
    process.exit(1)
  }

  if (!foundUsers || foundUsers.length === 0) {
    console.log(`  ✓ No user found with email ${ISO_USER_EMAIL} — already gone or never created`)
  } else {
    const userId = foundUsers[0].id
    console.log(`  ✓ Found user: ${userId}`)
    const { error: userDelErr } = await supabase.auth.admin.deleteUser(userId)
    if (userDelErr) {
      console.error('❌ auth.admin.deleteUser failed:', userDelErr)
      process.exit(1)
    }
    console.log(`  ✓ User deleted (cascades memberships, identity_links, audit refs)`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 2: Find and delete the isolation org
  // -------------------------------------------------------------------------
  console.log(`Step 2: Finding isolation org by slug...`)
  const { data: org, error: orgQueryErr } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('slug', ISO_ORG_SLUG)
    .maybeSingle()
  if (orgQueryErr) {
    console.error('❌ org query failed:', orgQueryErr)
    process.exit(1)
  }

  if (!org) {
    console.log(`  ✓ No org with slug "${ISO_ORG_SLUG}" — already gone or never created`)
  } else {
    console.log(`  ✓ Found org: ${org.id} (name: ${org.name})`)

    // Defensive: clear any straggling memberships before deleting the
    // org. CASCADE on org_memberships.org_id should handle this, but
    // we issue an explicit delete first so a stuck delete surfaces an
    // unambiguous error rather than a CASCADE side-effect.
    const { error: memDelErr } = await supabase
      .from('org_memberships')
      .delete()
      .eq('org_id', org.id)
    if (memDelErr) {
      console.error('❌ org_memberships cleanup failed:', memDelErr)
      process.exit(1)
    }

    const { error: orgDelErr } = await supabase
      .from('organizations')
      .delete()
      .eq('id', org.id)
    if (orgDelErr) {
      console.error('❌ organizations delete failed:', orgDelErr)
      process.exit(1)
    }
    console.log(`  ✓ Org ${org.id} deleted`)
  }
  console.log('')

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' Isolation fixture cleanup complete')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})
