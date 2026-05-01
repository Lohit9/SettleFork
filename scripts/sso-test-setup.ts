/**
 * SSO Test Setup — Phase 6 of the Okta runbook.
 *
 * Provisions the test artifacts needed to perform a SAML round-trip against
 * the Okta dev tenant configured in Phases 1-5 of the Okta setup.
 *
 * What this script does, in order:
 *   1. Resolve kaan@usesettle.ai's user_id via find_auth_user_by_email RPC
 *   2. Find or create the "SSO Test" org (slug 'sso-test'), with kaan as created_by
 *   3. Find or create org_memberships row: kaan as 'owner' of "SSO Test"
 *   4. Probe sso_domains for 'gmail.com' — bail if owned by a different org
 *   5. Probe sso_providers for the SSO Test org — if exists, DELETE GoTrue + DB rows first
 *   6. POST to GoTrue Admin SSO API to register Okta provider
 *   6b. PUT to GoTrue Admin SSO API to attach the test domain to that
 *       provider (Supabase's signInWithSSO uses domain-based lookup
 *       via this attribute; without it GoTrue returns "No such SSO
 *       provider" even though Settle's sso_domains row exists.)
 *   7. INSERT sso_providers row (capturing GoTrue's id as supabase_provider_id)
 *   8. INSERT sso_domains row mapping gmail.com -> SSO Test org
 *   9. UPDATE organizations: sso_enabled=true, sso_configured_at=now()
 *  10. Print verification block
 *
 * Idempotent: re-running this is safe. Existing artifacts are reused or replaced.
 *
 * To run:
 *   npm run sso:test:setup
 *   (or directly: npx tsx scripts/sso-test-setup.ts)
 *
 * To tear down: npm run sso:test:cleanup
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

// Load .env.local from repo root
config({ path: resolve(process.cwd(), '.env.local') })

// ============================================================================
// Constants — Okta tenant configured in Phases 1-5
// ============================================================================

const OKTA_TENANT = 'integrator-3106243'
const OKTA_APP_ID = 'exk12e0x2cbv0ArCp698'
const OKTA_ENTITY_ID = 'http://www.okta.com/exk12e0x2cbv0ArCp698'
const OKTA_METADATA_URL = `https://${OKTA_TENANT}.okta.com/app/${OKTA_APP_ID}/sso/saml/metadata`

const TEST_ORG_NAME = 'SSO Test'
const TEST_ORG_SLUG = 'sso-test'
const TEST_DOMAIN = 'gmail.com'
const FOUNDER_EMAIL = 'kaan@usesettle.ai'

// Attribute mapping — matches what Okta sends with our wizard config.
// Okta is configured to send 'email', 'first_name', 'last_name' as plain
// (Basic-format) attribute names, not namespace URIs.
const ATTRIBUTE_MAPPING = {
  keys: {
    email: { name: 'email' },
    first_name: { name: 'first_name' },
    last_name: { name: 'last_name' },
  },
}

// ============================================================================
// Env + client setup
// ============================================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

// Narrowed types for downstream calls
const SUPABASE_URL_STR: string = SUPABASE_URL
const SERVICE_KEY_STR: string = SERVICE_KEY

const supabase = createClient(SUPABASE_URL_STR, SERVICE_KEY_STR, {
  auth: { persistSession: false },
})

// Service Provider URLs — derived from Supabase project URL, same as
// what the wizard configured in Okta in Phase 3.
const ACS_URL = `${SUPABASE_URL_STR}/auth/v1/sso/saml/acs`
const SP_ENTITY_ID = `${SUPABASE_URL_STR}/auth/v1/sso/saml/metadata`

// ============================================================================
// GoTrue Admin SSO API — minimal fetch wrapper
// ============================================================================

interface GoTrueProvider {
  id: string
  saml?: {
    entity_id?: string
    metadata_url?: string
    metadata_xml?: string
  }
  created_at?: string
  updated_at?: string
}

async function gotruePost(body: Record<string, unknown>): Promise<GoTrueProvider> {
  const url = `${SUPABASE_URL_STR}/auth/v1/admin/sso/providers`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY_STR}`,
      apikey: SERVICE_KEY_STR,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GoTrue POST failed (${res.status}): ${text}`)
  }
  return JSON.parse(text) as GoTrueProvider
}

async function gotrueDelete(providerId: string): Promise<void> {
  const url = `${SUPABASE_URL_STR}/auth/v1/admin/sso/providers/${providerId}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY_STR}`,
      apikey: SERVICE_KEY_STR,
    },
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`GoTrue DELETE failed (${res.status}): ${text}`)
  }
}

async function gotruePut(
  providerId: string,
  body: Record<string, unknown>
): Promise<GoTrueProvider> {
  // PUT is the only verb GoTrue's Admin SSO API exposes for editing
  // an existing provider. Idempotent by Supabase's API design — the
  // body fields fully overwrite their counterparts on the server, so
  // re-running setup with the same domains list is a no-op on the
  // server's end-state (only the updated_at timestamp moves).
  const url = `${SUPABASE_URL_STR}/auth/v1/admin/sso/providers/${providerId}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY_STR}`,
      apikey: SERVICE_KEY_STR,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GoTrue PUT failed (${res.status}): ${text}`)
  }
  return JSON.parse(text) as GoTrueProvider
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' SSO Test Setup — Phase 6')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Supabase project: ${SUPABASE_URL_STR}`)
  console.log(`  Okta metadata:    ${OKTA_METADATA_URL}`)
  console.log(`  Test org:         ${TEST_ORG_NAME} (slug: ${TEST_ORG_SLUG})`)
  console.log(`  Test domain:      ${TEST_DOMAIN}`)
  console.log(`  Founder email:    ${FOUNDER_EMAIL}`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 1: Resolve founder user_id
  // -------------------------------------------------------------------------
  console.log('Step 1: Resolving founder user_id via find_auth_user_by_email...')
  const { data: foundUsers, error: findUserErr } = await supabase.rpc(
    'find_auth_user_by_email',
    { p_email: FOUNDER_EMAIL }
  )
  if (findUserErr) {
    console.error('❌ find_auth_user_by_email RPC failed:', findUserErr)
    process.exit(1)
  }
  if (!foundUsers || foundUsers.length === 0) {
    console.error(`❌ User ${FOUNDER_EMAIL} not found in auth.users. Are you on the right Supabase project?`)
    process.exit(1)
  }
  const founderUserId = foundUsers[0].id
  console.log(`  ✓ ${FOUNDER_EMAIL} -> ${founderUserId}`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 2: Find or create the SSO Test org
  // -------------------------------------------------------------------------
  console.log(`Step 2: Finding or creating org "${TEST_ORG_NAME}" (slug: ${TEST_ORG_SLUG})...`)
  const { data: existingOrg, error: orgQueryErr } = await supabase
    .from('organizations')
    .select('id, name, slug, sso_enabled, enforcement_mode, created_by')
    .eq('slug', TEST_ORG_SLUG)
    .maybeSingle()
  if (orgQueryErr) {
    console.error('❌ org query failed:', orgQueryErr)
    process.exit(1)
  }

  let orgId: string
  if (existingOrg) {
    orgId = existingOrg.id
    console.log(`  ✓ Found existing org: ${orgId}`)
    console.log(`    name: ${existingOrg.name}, sso_enabled: ${existingOrg.sso_enabled}, mode: ${existingOrg.enforcement_mode}`)
  } else {
    const { data: newOrg, error: orgInsertErr } = await supabase
      .from('organizations')
      .insert({
        name: TEST_ORG_NAME,
        slug: TEST_ORG_SLUG,
        created_by: founderUserId,
        // sso_enabled, enforcement_mode, sso_configured_at use defaults
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
  // Step 3: Find or create owner membership for kaan
  // -------------------------------------------------------------------------
  console.log(`Step 3: Ensuring ${FOUNDER_EMAIL} is owner of "${TEST_ORG_NAME}"...`)
  const { data: existingMember, error: memberQueryErr } = await supabase
    .from('org_memberships')
    .select('id, role, provisioning_source')
    .eq('org_id', orgId)
    .eq('user_id', founderUserId)
    .maybeSingle()
  if (memberQueryErr) {
    console.error('❌ membership query failed:', memberQueryErr)
    process.exit(1)
  }

  if (existingMember) {
    console.log(`  ✓ Existing membership found: role=${existingMember.role}, source=${existingMember.provisioning_source ?? 'null'}`)
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
      user_id: founderUserId,
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
  // Step 4: Probe sso_domains for gmail.com
  // -------------------------------------------------------------------------
  console.log(`Step 4: Probing sso_domains for "${TEST_DOMAIN}"...`)
  const { data: existingDomain, error: domainQueryErr } = await supabase
    .from('sso_domains')
    .select('id, org_id, domain')
    .eq('domain', TEST_DOMAIN)
    .maybeSingle()
  if (domainQueryErr) {
    console.error('❌ sso_domains query failed:', domainQueryErr)
    process.exit(1)
  }

  if (existingDomain) {
    if (existingDomain.org_id === orgId) {
      console.log(`  ✓ Domain "${TEST_DOMAIN}" already mapped to SSO Test org. Reusing.`)
    } else {
      console.error(`❌ Domain "${TEST_DOMAIN}" is already mapped to a DIFFERENT org: ${existingDomain.org_id}`)
      console.error(`   Globally UNIQUE constraint on sso_domains.domain.`)
      console.error(`   Resolution: identify and remove the conflicting mapping, or use a different test domain.`)
      process.exit(1)
    }
  } else {
    console.log(`  ✓ Domain "${TEST_DOMAIN}" is unclaimed.`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 5: Clean up any existing sso_provider for this org
  // -------------------------------------------------------------------------
  console.log(`Step 5: Checking for existing SSO provider on this org...`)
  const { data: existingProvider, error: providerQueryErr } = await supabase
    .from('sso_providers')
    .select('id, supabase_provider_id, idp_type, entity_id')
    .eq('org_id', orgId)
    .maybeSingle()
  if (providerQueryErr) {
    console.error('❌ sso_providers query failed:', providerQueryErr)
    process.exit(1)
  }

  if (existingProvider) {
    console.log(`  ⚠ Existing provider found: ${existingProvider.id}`)
    console.log(`    supabase_provider_id: ${existingProvider.supabase_provider_id}`)
    console.log(`    Removing it (DELETE GoTrue then DELETE row) to re-register cleanly...`)
    if (existingProvider.supabase_provider_id) {
      try {
        await gotrueDelete(existingProvider.supabase_provider_id)
        console.log(`  ✓ GoTrue provider deleted`)
      } catch (err) {
        console.error(`  ⚠ GoTrue delete failed (continuing anyway):`, err)
      }
    }
    const { error: providerDelErr } = await supabase
      .from('sso_providers')
      .delete()
      .eq('id', existingProvider.id)
    if (providerDelErr) {
      console.error('❌ sso_providers delete failed:', providerDelErr)
      process.exit(1)
    }
    console.log(`  ✓ DB row deleted`)
  } else {
    console.log(`  ✓ No existing provider`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 6: POST to GoTrue Admin SSO API
  // -------------------------------------------------------------------------
  console.log(`Step 6: POSTing SAML provider to GoTrue Admin SSO API...`)
  console.log(`  POST ${SUPABASE_URL_STR}/auth/v1/admin/sso/providers`)
  console.log(`  body: { type: 'saml', metadata_url: '${OKTA_METADATA_URL}', attribute_mapping: {...} }`)
  let gotrueProvider: GoTrueProvider
  try {
    gotrueProvider = await gotruePost({
      type: 'saml',
      metadata_url: OKTA_METADATA_URL,
      attribute_mapping: ATTRIBUTE_MAPPING,
    })
  } catch (err) {
    console.error('❌ GoTrue POST failed:', err)
    process.exit(1)
  }
  console.log(`  ✓ GoTrue provider created: ${gotrueProvider.id}`)
  if (gotrueProvider.saml?.entity_id) {
    console.log(`    GoTrue parsed entity_id: ${gotrueProvider.saml.entity_id}`)
    if (gotrueProvider.saml.entity_id !== OKTA_ENTITY_ID) {
      console.warn(`  ⚠ Parsed entity_id does not match expected ${OKTA_ENTITY_ID}`)
      console.warn(`     Continuing anyway — this is informational.`)
    }
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 6b: Attach the test domain to the GoTrue provider
  // -------------------------------------------------------------------------
  // Without this PUT, GoTrue's domains array is [] for the provider
  // and Supabase's signInWithSSO returns "No such SSO provider" for
  // domain-keyed lookups even though Settle's sso_domains row exists.
  // The Settle code path uses provider-id-keyed signInWithSSO so it
  // works without this — but attaching the domain server-side keeps
  // the two stores consistent and unblocks domain-keyed lookup paths.
  // Non-fatal: if the PUT fails we warn and continue. The provider
  // remains usable from Settle (sso_domains is the authoritative
  // source for our application code).
  console.log(`Step 6b: PUTing domain "${TEST_DOMAIN}" onto GoTrue provider...`)
  try {
    await gotruePut(gotrueProvider.id, { domains: [TEST_DOMAIN] })
    console.log(`  ✓ Domain '${TEST_DOMAIN}' attached to GoTrue provider`)
  } catch (err) {
    console.warn(`  ⚠ GoTrue domain attach failed (continuing — Settle's sso_domains row is authoritative):`, err)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 7: INSERT sso_providers row
  // -------------------------------------------------------------------------
  console.log(`Step 7: INSERTing sso_providers row...`)
  const { data: insertedProvider, error: providerInsertErr } = await supabase
    .from('sso_providers')
    .insert({
      org_id: orgId,
      supabase_provider_id: gotrueProvider.id,
      idp_type: 'okta',
      entity_id: OKTA_ENTITY_ID,
      metadata_url: OKTA_METADATA_URL,
      acs_url: ACS_URL,
      sp_entity_id: SP_ENTITY_ID,
      attribute_mapping: ATTRIBUTE_MAPPING,
      created_by: founderUserId,
    })
    .select('id')
    .single()
  if (providerInsertErr || !insertedProvider) {
    console.error('❌ sso_providers insert failed:', providerInsertErr)
    console.error('   Rolling back GoTrue provider...')
    try {
      await gotrueDelete(gotrueProvider.id)
      console.error('   ✓ GoTrue rollback succeeded')
    } catch (rollbackErr) {
      console.error('   ❌ GoTrue rollback FAILED — manual cleanup required:', rollbackErr)
      console.error(`      Dangling GoTrue provider id: ${gotrueProvider.id}`)
    }
    process.exit(1)
  }
  console.log(`  ✓ sso_providers row created: ${insertedProvider.id}`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 8: INSERT sso_domains row (idempotent — skip if already mapped to this org)
  // -------------------------------------------------------------------------
  console.log(`Step 8: INSERTing sso_domains row...`)
  if (existingDomain && existingDomain.org_id === orgId) {
    console.log(`  ✓ Already exists, skipping`)
  } else {
    const { error: domainInsertErr } = await supabase.from('sso_domains').insert({
      org_id: orgId,
      domain: TEST_DOMAIN,
      added_by: founderUserId,
    })
    if (domainInsertErr) {
      console.error('❌ sso_domains insert failed:', domainInsertErr)
      console.error('   Manual cleanup may be required.')
      process.exit(1)
    }
    console.log(`  ✓ sso_domains row created: ${TEST_DOMAIN} -> ${orgId}`)
  }
  console.log('')

  // -------------------------------------------------------------------------
  // Step 9: Flip sso_enabled and sso_configured_at on the org
  // -------------------------------------------------------------------------
  console.log(`Step 9: Setting organizations.sso_enabled=true, sso_configured_at=now()...`)
  const { error: orgUpdateErr } = await supabase
    .from('organizations')
    .update({
      sso_enabled: true,
      sso_configured_at: new Date().toISOString(),
    })
    .eq('id', orgId)
  if (orgUpdateErr) {
    console.error('❌ organizations update failed:', orgUpdateErr)
    process.exit(1)
  }
  console.log(`  ✓ org sso_enabled=true, sso_configured_at set`)
  console.log('')

  // -------------------------------------------------------------------------
  // Step 10: Print verification block
  // -------------------------------------------------------------------------
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' Setup complete — Phase 6 done')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Recorded values:')
  console.log(`  org_id:              ${orgId}`)
  console.log(`  org_slug:            ${TEST_ORG_SLUG}`)
  console.log(`  sso_provider_id:     ${insertedProvider.id} (Settle PK)`)
  console.log(`  supabase_provider_id: ${gotrueProvider.id} (GoTrue UUID)`)
  console.log(`  domain:              ${TEST_DOMAIN}`)
  console.log(`  founder_user_id:     ${founderUserId}`)
  console.log('')
  console.log('Phase 7 — log in via SAML:')
  console.log('')
  console.log('  In an INCOGNITO browser window, navigate to:')
  console.log('')
  console.log(`    http://localhost:3001/sso/start?email=${encodeURIComponent('kaandincer1+ssotest@gmail.com')}`)
  console.log('')
  console.log('  (Adjust port if your dev server is not on 3001.)')
  console.log('  You should be redirected to Okta, log in with the test user,')
  console.log('  and end up authenticated in Settle.')
  console.log('')
  console.log('Test user credentials:')
  console.log(`  email:    kaandincer1+ssotest@gmail.com`)
  console.log(`  password: Settle-SSO-Test-2026!`)
  console.log('')
  console.log('Phase 9 SQL queries — run in Supabase SQL Editor after login:')
  console.log('')
  console.log(`  SELECT id, user_id, provider, identity_data->>'email' AS email, created_at`)
  console.log(`  FROM auth.identities`)
  console.log(`  WHERE identity_data->>'email' = 'kaandincer1+ssotest@gmail.com';`)
  console.log('')
  console.log(`  SELECT * FROM get_auth_identity_providers('<user_id_from_above>'::uuid);`)
  console.log('')
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})
