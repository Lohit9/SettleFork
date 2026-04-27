/**
 * SSO Test Cleanup — Phase 10 of the Okta runbook.
 *
 * Conservative default:
 *   - DELETE sso_providers row (Settle DB) and the corresponding GoTrue provider
 *   - DELETE sso_domains row (gmail.com -> SSO Test)
 *   - UPDATE organizations: sso_enabled=false, sso_configured_at=null
 *   - LEAVE: organization, kaan's org_membership, JIT'd test user
 *
 * Aggressive (--full):
 *   - All of the above, PLUS:
 *   - DELETE the JIT'd test user from auth.users (cascades sso_identity_links etc.)
 *   - DELETE org_memberships for the SSO Test org
 *   - DELETE the SSO Test organization
 *
 * Idempotent: re-running is safe.
 *
 * To run:
 *   npm run sso:test:cleanup           (conservative)
 *   npm run sso:test:cleanup -- --full (aggressive)
 *
 * Or directly:
 *   npx tsx scripts/sso-test-cleanup.ts
 *   npx tsx scripts/sso-test-cleanup.ts --full
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env.local from repo root
config({ path: resolve(process.cwd(), '.env.local') })

// ============================================================================
// Constants — must match sso-test-setup.ts
// ============================================================================

const TEST_ORG_SLUG = 'sso-test'
const TEST_DOMAIN = 'gmail.com'
const TEST_USER_EMAIL = 'kaandincer1+ssotest@gmail.com'

// ============================================================================
// Env + client setup
// ============================================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const SUPABASE_URL_STR: string = SUPABASE_URL
const SERVICE_KEY_STR: string = SERVICE_KEY

const supabase = createClient(SUPABASE_URL_STR, SERVICE_KEY_STR, {
  auth: { persistSession: false },
})

// Detect --full flag
const FULL_CLEANUP = process.argv.includes('--full')

// ============================================================================
// GoTrue Admin SSO API
// ============================================================================

async function gotrueDelete(providerId: string): Promise<boolean> {
  const url = `${SUPABASE_URL_STR}/auth/v1/admin/sso/providers/${providerId}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY_STR}`,
      apikey: SERVICE_KEY_STR,
    },
  })
  if (res.status === 404) return false // already gone, fine
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GoTrue DELETE failed (${res.status}): ${text}`)
  }
  return true
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` SSO Test Cleanup — Phase 10 ${FULL_CLEANUP ? '(--full)' : '(conservative)'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Supabase project: ${SUPABASE_URL_STR}`)
  console.log(`  Test org slug:    ${TEST_ORG_SLUG}`)
  console.log(`  Test domain:      ${TEST_DOMAIN}`)
  if (FULL_CLEANUP) {
    console.log(`  Mode:             AGGRESSIVE — deletes org, memberships, and JIT'd test user`)
  } else {
    console.log(`  Mode:             CONSERVATIVE — leaves org, memberships, and test user intact`)
    console.log(`                    Run with --full to remove everything.`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 1: Find the SSO Test org
  // -------------------------------------------------------------------------
  console.log('Step 1: Finding SSO Test org...')
  const { data: org, error: orgQueryErr } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', TEST_ORG_SLUG)
    .maybeSingle()
  if (orgQueryErr) {
    console.error('❌ org query failed:', orgQueryErr)
    process.exit(1)
  }
  if (!org) {
    console.log(`  ✓ No org with slug "${TEST_ORG_SLUG}" — nothing to clean up`)
    process.exit(0)
  }
  const orgId = org.id
  console.log(`  ✓ Found org: ${orgId} (name: ${org.name})`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 2: Find sso_providers row and DELETE GoTrue + DB row
  // -------------------------------------------------------------------------
  console.log('Step 2: Removing sso_providers row + GoTrue provider...')
  const { data: provider, error: providerQueryErr } = await supabase
    .from('sso_providers')
    .select('id, supabase_provider_id')
    .eq('org_id', orgId)
    .maybeSingle()
  if (providerQueryErr) {
    console.error('❌ sso_providers query failed:', providerQueryErr)
    process.exit(1)
  }

  if (!provider) {
    console.log(`  ✓ No sso_providers row for this org`)
  } else {
    if (provider.supabase_provider_id) {
      try {
        const deleted = await gotrueDelete(provider.supabase_provider_id)
        console.log(`  ✓ GoTrue provider ${deleted ? 'deleted' : 'was already gone'}`)
      } catch (err) {
        console.error(`  ⚠ GoTrue delete failed (continuing):`, err)
      }
    }
    const { error: providerDelErr } = await supabase
      .from('sso_providers')
      .delete()
      .eq('id', provider.id)
    if (providerDelErr) {
      console.error('❌ sso_providers delete failed:', providerDelErr)
      process.exit(1)
    }
    console.log(`  ✓ sso_providers row deleted`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 3: DELETE sso_domains row for this org
  // -------------------------------------------------------------------------
  console.log(`Step 3: Removing sso_domains row for "${TEST_DOMAIN}"...`)
  const { data: deletedDomains, error: domainDelErr } = await supabase
    .from('sso_domains')
    .delete()
    .eq('org_id', orgId)
    .eq('domain', TEST_DOMAIN)
    .select('id, domain')
  if (domainDelErr) {
    console.error('❌ sso_domains delete failed:', domainDelErr)
    process.exit(1)
  }
  if (deletedDomains && deletedDomains.length > 0) {
    console.log(`  ✓ Removed ${deletedDomains.length} sso_domains row(s): ${deletedDomains.map((d) => d.domain).join(', ')}`)
  } else {
    console.log(`  ✓ No sso_domains row to remove`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 4: Reset sso_enabled / sso_configured_at on the org
  // -------------------------------------------------------------------------
  console.log('Step 4: Resetting organizations.sso_enabled=false, sso_configured_at=null...')
  const { error: orgUpdateErr } = await supabase
    .from('organizations')
    .update({
      sso_enabled: false,
      sso_configured_at: null,
    })
    .eq('id', orgId)
  if (orgUpdateErr) {
    console.error('❌ organizations update failed:', orgUpdateErr)
    process.exit(1)
  }
  console.log(`  ✓ org sso_enabled=false`)
  console.log('')

  // -------------------------------------------------------------------------
  // Aggressive mode: tear down org + memberships + JIT'd user
  // -------------------------------------------------------------------------
  if (FULL_CLEANUP) {
    console.log('━━━ AGGRESSIVE CLEANUP ━━━')
    console.log('')

    // Step 5: Find and delete the JIT'd test user
    console.log(`Step 5 (--full): Finding JIT'd test user ${TEST_USER_EMAIL}...`)
    const { data: foundUsers, error: findUserErr } = await supabase.rpc(
      'find_auth_user_by_email',
      { p_email: TEST_USER_EMAIL }
    )
    if (findUserErr) {
      console.error('❌ find_auth_user_by_email RPC failed:', findUserErr)
      process.exit(1)
    }

    if (!foundUsers || foundUsers.length === 0) {
      console.log(`  ✓ No JIT'd user found (login may not have happened yet, or user already deleted)`)
    } else {
      const testUserId = foundUsers[0].id
      console.log(`  ✓ Found test user: ${testUserId}`)
      const { error: userDelErr } = await supabase.auth.admin.deleteUser(testUserId)
      if (userDelErr) {
        console.error('❌ auth.admin.deleteUser failed:', userDelErr)
        process.exit(1)
      }
      console.log(`  ✓ Test user deleted from auth.users (cascades to memberships, identity_links)`)
    }
    console.log('')

    // Step 6: Delete remaining memberships for the org (kaan's owner row)
    console.log('Step 6 (--full): Deleting org_memberships for SSO Test org...')
    const { data: deletedMembers, error: memberDelErr } = await supabase
      .from('org_memberships')
      .delete()
      .eq('org_id', orgId)
      .select('id, user_id, role')
    if (memberDelErr) {
      console.error('❌ org_memberships delete failed:', memberDelErr)
      process.exit(1)
    }
    console.log(`  ✓ Removed ${deletedMembers?.length ?? 0} membership(s)`)
    console.log('')

    // Step 7: Delete the org itself
    console.log('Step 7 (--full): Deleting SSO Test organization...')
    const { error: orgDelErr } = await supabase.from('organizations').delete().eq('id', orgId)
    if (orgDelErr) {
      console.error('❌ organizations delete failed:', orgDelErr)
      process.exit(1)
    }
    console.log(`  ✓ Org ${orgId} deleted`)
    console.log('')
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` Cleanup complete ${FULL_CLEANUP ? '(--full)' : '(conservative)'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (!FULL_CLEANUP) {
    console.log('')
    console.log('Conservative cleanup left intact:')
    console.log(`  - SSO Test organization (id: ${orgId})`)
    console.log(`  - kaan@usesettle.ai owner membership`)
    console.log(`  - JIT'd test user ${TEST_USER_EMAIL} (if Phase 7 logged in)`)
    console.log('')
    console.log('To remove all of the above, re-run with --full:')
    console.log('  npm run sso:test:cleanup -- --full')
  }
  console.log('')
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})