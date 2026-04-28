/**
 * SSO Cross-Tenant Isolation Fixture Setup (B-2-c-ii commit 1).
 *
 * Provisions the second-tenant fixture used by
 * `tests/integration/sso-admin-isolation.test.ts` to prove that
 * `requireOrgAdmin(orgId)` correctly rejects cross-tenant calls. The
 * fixture creates a real `auth.users` row, a real `organizations`
 * row, and a real `org_memberships` row putting User 2 as `owner` of
 * the isolation org — but NO sso_providers, NO sso_domains, and
 * `sso_enabled = false`.
 *
 * Why no Okta App 2 / no sso_providers / no domain (Mini-D session
 * 2026-04-28, hybrid path)
 * ----------------------------------------------------------------
 * The cross-tenant tests never exercise the SAML round-trip — they
 * test the authorization gate inside `requireOrgAdmin`. The gate
 * only reads `org_memberships`. Mocking `createClient()` via
 * `vi.mock('@/lib/supabase/server', ...)` (the existing Heritage
 * integration pattern; see `tests/integration/bulk-approve-heritage.
 * test.ts:64-82`) lets us stand in as User 2 without a real cookie
 * session. The provisioned User 2 only needs to exist in `auth.users`
 * so that membership lookups can return / NOT-return rows for that
 * UUID. Setting up a second SAML app + real password sign-in is
 * unnecessary for this test surface and is recorded as a follow-up
 * item in `docs/outstanding-items.md`.
 *
 * Idempotent: re-running this is safe. Existing artifacts are
 * detected and reused. Use `sso:test:cleanup:isolation` to tear down.
 *
 * To run:
 *   npm run sso:test:setup:isolation
 *   (or directly: npx tsx scripts/sso-test-setup-isolation.ts)
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env.local from repo root
config({ path: resolve(process.cwd(), '.env.local') })

// ============================================================================
// Constants — kept in lockstep with the cleanup script
// ============================================================================

// The isolation org's name + slug deliberately do NOT collide with
// the primary SSO Test org (`sso-test`). UNIQUE(slug) on
// organizations would error otherwise.
const ISO_ORG_NAME = 'SSO Isolation Test'
const ISO_ORG_SLUG = 'sso-isolation-test'

// Synthetic Gmail subaddress so the user is mailable but never
// conflicts with the primary fixture's `+ssotest` user. Password is
// not used by the test suite (we mock the auth client) but is set so
// the auth.users row passes Supabase's createUser validation.
const ISO_USER_EMAIL = 'kaandincer1+ssoisolation@gmail.com'
const ISO_USER_PASSWORD = 'Settle-SSO-Isolation-2026!'

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
  console.log(' SSO Isolation Fixture Setup — B-2-c-ii commit 1')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Supabase project: ${SUPABASE_URL_STR}`)
  console.log(`  Iso org name:     ${ISO_ORG_NAME}`)
  console.log(`  Iso org slug:     ${ISO_ORG_SLUG}`)
  console.log(`  Iso user email:   ${ISO_USER_EMAIL}`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 1: Find or create User 2 in auth.users
  // -------------------------------------------------------------------------
  console.log(`Step 1: Finding or creating user "${ISO_USER_EMAIL}"...`)
  const { data: foundUsers, error: findUserErr } = await supabase.rpc(
    'find_auth_user_by_email',
    { p_email: ISO_USER_EMAIL },
  )
  if (findUserErr) {
    console.error('❌ find_auth_user_by_email RPC failed:', findUserErr)
    process.exit(1)
  }

  let userId: string
  if (foundUsers && foundUsers.length > 0) {
    userId = foundUsers[0].id
    console.log(`  ✓ Found existing user: ${userId}`)
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: ISO_USER_EMAIL,
      password: ISO_USER_PASSWORD,
      email_confirm: true, // skip the confirmation email — service-role can do this
    })
    if (createErr || !created.user) {
      console.error('❌ auth.admin.createUser failed:', createErr)
      process.exit(1)
    }
    userId = created.user.id
    console.log(`  ✓ Created user: ${userId}`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 2: Find or create the isolation org
  // -------------------------------------------------------------------------
  console.log(`Step 2: Finding or creating org "${ISO_ORG_NAME}" (slug: ${ISO_ORG_SLUG})...`)
  const { data: existingOrg, error: orgQueryErr } = await supabase
    .from('organizations')
    .select('id, name, slug, sso_enabled, enforcement_mode')
    .eq('slug', ISO_ORG_SLUG)
    .maybeSingle()
  if (orgQueryErr) {
    console.error('❌ org query failed:', orgQueryErr)
    process.exit(1)
  }

  let orgId: string
  if (existingOrg) {
    orgId = existingOrg.id
    console.log(`  ✓ Found existing org: ${orgId}`)
    console.log(
      `    sso_enabled: ${existingOrg.sso_enabled}, enforcement_mode: ${existingOrg.enforcement_mode}`,
    )
  } else {
    const { data: newOrg, error: orgInsertErr } = await supabase
      .from('organizations')
      .insert({
        name: ISO_ORG_NAME,
        slug: ISO_ORG_SLUG,
        created_by: userId,
        // sso_enabled defaults to false — intentional. The isolation
        // tests do not exercise SSO discovery paths, so leaving the
        // org without a provider/domain prevents accidental cross-org
        // login routing during local dev.
      })
      .select('id')
      .single()
    if (orgInsertErr || !newOrg) {
      console.error('❌ org insert failed:', orgInsertErr)
      process.exit(1)
    }
    orgId = newOrg.id
    console.log(`  ✓ Created org: ${orgId}`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 3: Find or create owner membership for User 2
  // -------------------------------------------------------------------------
  console.log(`Step 3: Ensuring User 2 is owner of "${ISO_ORG_NAME}"...`)
  const { data: existingMember, error: memberQueryErr } = await supabase
    .from('org_memberships')
    .select('id, role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()
  if (memberQueryErr) {
    console.error('❌ membership query failed:', memberQueryErr)
    process.exit(1)
  }

  if (existingMember) {
    console.log(`  ✓ Existing membership: role=${existingMember.role}`)
    if (existingMember.role !== 'owner') {
      const { error: updateErr } = await supabase
        .from('org_memberships')
        .update({ role: 'owner' })
        .eq('id', existingMember.id)
      if (updateErr) {
        console.error('❌ membership role update failed:', updateErr)
        process.exit(1)
      }
      console.log(`  ✓ Upgraded role to 'owner'`)
    }
  } else {
    const { error: memberInsertErr } = await supabase.from('org_memberships').insert({
      org_id: orgId,
      user_id: userId,
      role: 'owner',
      provisioning_source: 'admin',
    })
    if (memberInsertErr) {
      console.error('❌ membership insert failed:', memberInsertErr)
      process.exit(1)
    }
    console.log(`  ✓ Created owner membership`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 4: Confirm User 2 has NO membership in the primary SSO Test org
  // -------------------------------------------------------------------------
  // The whole point of the fixture: User 2 must NOT be a member of
  // any other org. Otherwise, when isolation tests pass User 1's
  // org_id and User 2's session, requireOrgAdmin might return ok:true
  // for the wrong reason and we'd see a false negative on the
  // rejection assertion.
  console.log('Step 4: Verifying User 2 has no other org memberships...')
  const { data: otherMemberships, error: otherErr } = await supabase
    .from('org_memberships')
    .select('id, org_id, role')
    .eq('user_id', userId)
    .neq('org_id', orgId)
  if (otherErr) {
    console.error('❌ cross-org membership query failed:', otherErr)
    process.exit(1)
  }
  if (otherMemberships && otherMemberships.length > 0) {
    console.warn(
      `  ⚠ User 2 has ${otherMemberships.length} membership(s) outside the isolation org:`,
    )
    for (const m of otherMemberships) {
      console.warn(`     org_id=${m.org_id} role=${m.role}`)
    }
    console.warn(
      '  ⚠ Isolation tests may produce false negatives. Consider removing these manually, or run:',
    )
    console.warn('     npm run sso:test:cleanup:isolation && npm run sso:test:setup:isolation')
  } else {
    console.log('  ✓ User 2 has no other memberships — isolation boundary is clean')
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 5: Print verification + test invocation block
  // -------------------------------------------------------------------------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' Isolation fixture ready')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Recorded values:')
  console.log(`  iso_org_id:     ${orgId}`)
  console.log(`  iso_org_slug:   ${ISO_ORG_SLUG}`)
  console.log(`  iso_user_id:    ${userId}`)
  console.log(`  iso_user_email: ${ISO_USER_EMAIL}`)
  console.log('')
  console.log('To run the isolation suite:')
  console.log('')
  console.log('  SETTLE_SSO_ADMIN_ISOLATION_TEST=1 \\')
  console.log('    npm test -- tests/integration/sso-admin-isolation.test.ts')
  console.log('')
  console.log('To tear down:')
  console.log('  npm run sso:test:cleanup:isolation')
  console.log('')
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})
