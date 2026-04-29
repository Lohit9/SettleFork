// @vitest-environment node
//
// Integration test — project-level RBAC strict membership (PR 1).
//
// What this validates (behaviorally, not via source-shape regex):
//
//   1. CROSS-ORG ISOLATION — A user in Org A who is NOT in
//      project_members for Project X cannot SELECT Project X. Pre-079
//      the org-membership fallback would have let any Org A member see
//      every Project X in Org A. Post-079 the strict membership rule
//      blocks them.
//
//   2. PROJECT-MEMBERS GRANT — A user in Org A who IS in project_members
//      for Project X CAN SELECT Project X.
//
//   3. ROLE FROM PROJECT_MEMBERS ONLY — `get_user_project_role` returns
//      the project_members.role for the (user, project) pair. NULL when
//      no row exists, regardless of org membership. The legacy COALESCE
//      fallback to org_memberships.role is gone.
//
//   4. STICKINESS — Removing a user's org_memberships row does NOT
//      remove their project_members row. The user retains project
//      access until the project_members row is also removed (or until
//      removeMember Server Action explicitly sweeps both). This guards
//      against a regression where a future trigger or fanout
//      re-introduces "auto-revoke on org leave" behavior.
//
// What this test does NOT cover (out of scope for this file):
//   - Hierarchy comparisons of user_has_project_role across all role
//     pairs. The hierarchy literal is pinned by the source-level test
//     in `tests/migrations/079-project-rbac-strict-membership.test.ts`.
//   - Auto-grant fanout RPCs. Those are exercised end-to-end in the
//     Server Action callsites; this file would duplicate that coverage
//     and add 2-3x runtime.
//   - SAML/JIT provisioning paths. Covered by 071/072 SSO migrations.
//
// ─── Why a real session (not service-role) ──────────────────────────
//
// The functions under test (`get_user_project_role`,
// `user_can_access_project`, the projects SELECT RLS policy) all key
// off `auth.uid()`. Service-role JWTs do not carry a `sub` claim, so
// auth.uid() returns NULL when called over a service-role client and
// any access check fails closed. We must sign in as the test user with
// password credentials to get a real JWT with a `sub` claim, then
// exercise the RLS policies with that authenticated session.
//
// ─── Env-gating ─────────────────────────────────────────────────────
//
// Required (all must be set):
//   RUN_PROJECT_RBAC_INTEGRATION=1     explicit opt-in
//   NEXT_PUBLIC_SUPABASE_URL           Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY          for createUser / data setup
//   NEXT_PUBLIC_SUPABASE_ANON_KEY      for password sign-in
//
// Run locally:
//   RUN_PROJECT_RBAC_INTEGRATION=1 npx vitest run \
//     tests/integration/project-rbac-strict-membership.test.ts
//
// Excluded from the standard quality gate (vitest.config.ts excludes
// tests/integration/**). Keeping this gated has a cost — regressions
// to RLS/SQL behavior won't be caught by `npm test`. The trade-off is
// (a) every run mutates a real Supabase project, and (b) the test
// must run against a Supabase instance with SERVICE_ROLE creds, which
// is friction we don't want on every developer machine. The source-
// level invariant tests catch the most common regressions; this test
// is the catch-net for the deeper SQL-level bugs source tests can't
// see.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const RUN = process.env.RUN_PROJECT_RBAC_INTEGRATION === '1'
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const HAS_ENV = RUN && Boolean(URL) && Boolean(SERVICE_KEY) && Boolean(ANON_KEY)
const describeFn = HAS_ENV ? describe : describe.skip

interface TestState {
  orgA: string
  orgB: string
  ownerAUserId: string
  memberAUserId: string
  memberBUserId: string
  ownerAEmail: string
  memberAEmail: string
  memberBEmail: string
  password: string
  projectAOwnedByAdmin: string  // in orgA, ownerA is admin via project creator
  projectAMemberAdded: string   // in orgA, memberA added explicitly via project_members
  projectBIsolated: string      // in orgB, no orgA users in project_members
}

const STATE = {} as TestState

describeFn('project-rbac strict membership (079) — RLS + role resolution', () => {
  const supabaseAdmin = createClient(URL!, SERVICE_KEY!)

  const stamp = Date.now().toString(36)
  STATE.password = `Test_${stamp}_PRBAC!`
  STATE.ownerAEmail = `prbac-owner-a-${stamp}@example.test`
  STATE.memberAEmail = `prbac-member-a-${stamp}@example.test`
  STATE.memberBEmail = `prbac-member-b-${stamp}@example.test`

  // ─── Setup ────────────────────────────────────────────────────────
  beforeAll(async () => {
    // Two orgs: Org A is the cross-org isolation subject; Org B is the
    // negative-control container that proves the user can't see Org A
    // projects from Org B-side view either.
    const { data: orgA } = await supabaseAdmin
      .from('organizations')
      .insert({ name: `PRBAC Org A ${stamp}`, slug: `prbac-a-${stamp}` })
      .select('id').single()
    STATE.orgA = orgA!.id

    const { data: orgB } = await supabaseAdmin
      .from('organizations')
      .insert({ name: `PRBAC Org B ${stamp}`, slug: `prbac-b-${stamp}` })
      .select('id').single()
    STATE.orgB = orgB!.id

    // Three test users via auth.admin.createUser — all email_confirm:true so
    // password sign-in works without verification flow.
    const create = async (email: string) => {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email, password: STATE.password, email_confirm: true,
      })
      if (error) throw error
      return data.user!.id
    }
    STATE.ownerAUserId  = await create(STATE.ownerAEmail)
    STATE.memberAUserId = await create(STATE.memberAEmail)
    STATE.memberBUserId = await create(STATE.memberBEmail)

    // Org memberships:
    //   ownerA is owner of Org A
    //   memberA is member of Org A (will be denied access to Org A
    //           projects unless added to project_members directly)
    //   memberB is member of Org B (separate-org control)
    await supabaseAdmin.from('org_memberships').insert([
      { org_id: STATE.orgA, user_id: STATE.ownerAUserId,  role: 'owner' },
      { org_id: STATE.orgA, user_id: STATE.memberAUserId, role: 'member' },
      { org_id: STATE.orgB, user_id: STATE.memberBUserId, role: 'member' },
    ])

    // Three projects:
    //   projectAOwnedByAdmin — created by ownerA in Org A; ownerA gets
    //     admin via grant_new_project_access; memberA is a member of Org
    //     A but member_auto_grant is true by default so memberA also
    //     gets editor — to keep the cross-org isolation case clean we
    //     turn the toggle OFF on Org A first, so memberA gets no
    //     auto-grant on this project.
    await supabaseAdmin
      .from('organizations')
      .update({ member_auto_grant_enabled: false })
      .eq('id', STATE.orgA)

    const { data: projectA1 } = await supabaseAdmin
      .from('projects')
      .insert({
        name: `PRBAC Project A1 ${stamp}`,
        org_id: STATE.orgA,
        user_id: STATE.ownerAUserId,
        created_by: STATE.ownerAUserId,
        use_mapping_redesign: true,
      })
      .select('id').single()
    STATE.projectAOwnedByAdmin = projectA1!.id

    // Manually grant access via the SECURITY DEFINER RPC (mirrors the
    // production createProject path). Toggle is OFF, so memberA is NOT
    // auto-granted; only ownerA + ownerA-as-creator gets a row.
    await supabaseAdmin.rpc('grant_new_project_access', {
      p_project_id: STATE.projectAOwnedByAdmin,
      p_org_id: STATE.orgA,
      p_creator_id: STATE.ownerAUserId,
    })

    //   projectAMemberAdded — separate Org A project. memberA is then
    //     added explicitly via project_members so we can prove that
    //     membership grants visibility.
    const { data: projectA2 } = await supabaseAdmin
      .from('projects')
      .insert({
        name: `PRBAC Project A2 ${stamp}`,
        org_id: STATE.orgA,
        user_id: STATE.ownerAUserId,
        created_by: STATE.ownerAUserId,
        use_mapping_redesign: true,
      })
      .select('id').single()
    STATE.projectAMemberAdded = projectA2!.id

    await supabaseAdmin.rpc('grant_new_project_access', {
      p_project_id: STATE.projectAMemberAdded,
      p_org_id: STATE.orgA,
      p_creator_id: STATE.ownerAUserId,
    })

    // Add memberA explicitly as 'editor' on projectA2 only.
    await supabaseAdmin.from('project_members').insert({
      project_id: STATE.projectAMemberAdded,
      user_id: STATE.memberAUserId,
      role: 'editor',
      assigned_by: STATE.ownerAUserId,
    })

    //   projectBIsolated — Org B project, no Org A users in project_members.
    const { data: projectB1 } = await supabaseAdmin
      .from('projects')
      .insert({
        name: `PRBAC Project B1 ${stamp}`,
        org_id: STATE.orgB,
        user_id: STATE.memberBUserId,
        created_by: STATE.memberBUserId,
        use_mapping_redesign: true,
      })
      .select('id').single()
    STATE.projectBIsolated = projectB1!.id

    await supabaseAdmin.rpc('grant_new_project_access', {
      p_project_id: STATE.projectBIsolated,
      p_org_id: STATE.orgB,
      p_creator_id: STATE.memberBUserId,
    })
  }, 60_000)

  // ─── Cleanup ──────────────────────────────────────────────────────
  afterAll(async () => {
    // Order: project_members → projects → org_memberships → orgs → users.
    // Each parent table has ON DELETE CASCADE on most children so we
    // could rely on cascade, but explicit ordering is more readable
    // when something fails halfway.
    if (STATE.projectAOwnedByAdmin) await supabaseAdmin.from('projects').delete().eq('id', STATE.projectAOwnedByAdmin)
    if (STATE.projectAMemberAdded)  await supabaseAdmin.from('projects').delete().eq('id', STATE.projectAMemberAdded)
    if (STATE.projectBIsolated)     await supabaseAdmin.from('projects').delete().eq('id', STATE.projectBIsolated)
    if (STATE.orgA) await supabaseAdmin.from('organizations').delete().eq('id', STATE.orgA)
    if (STATE.orgB) await supabaseAdmin.from('organizations').delete().eq('id', STATE.orgB)
    for (const uid of [STATE.ownerAUserId, STATE.memberAUserId, STATE.memberBUserId]) {
      if (uid) await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }, 60_000)

  // Sign-in helper: returns a Supabase JS client whose auth context is
  // a real user session (so auth.uid() resolves correctly inside RLS).
  async function signInAs(email: string) {
    const client = createClient(URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await client.auth.signInWithPassword({
      email, password: STATE.password,
    })
    if (error) throw new Error(`signIn failed for ${email}: ${error.message}`)
    return client
  }

  // ─── 1. Cross-org isolation ───────────────────────────────────────
  it('memberA (org-A member without project_members row) cannot SELECT projectAOwnedByAdmin', async () => {
    const client = await signInAs(STATE.memberAEmail)
    const { data, error } = await client
      .from('projects')
      .select('id, name')
      .eq('id', STATE.projectAOwnedByAdmin)
      .maybeSingle()
    expect(error).toBeNull()
    // Empty result, NOT a permission error — RLS hides the row entirely.
    expect(data).toBeNull()
  })

  // ─── 2. Project membership grants visibility ──────────────────────
  it('memberA (added explicitly to projectA2 via project_members) CAN SELECT projectAMemberAdded', async () => {
    const client = await signInAs(STATE.memberAEmail)
    const { data, error } = await client
      .from('projects')
      .select('id, name')
      .eq('id', STATE.projectAMemberAdded)
      .maybeSingle()
    expect(error).toBeNull()
    expect(data?.id).toBe(STATE.projectAMemberAdded)
  })

  // ─── 3. Cross-org isolation (negative control) ────────────────────
  it('memberB (org-B member, no project_members row in org-A) cannot SELECT any org-A project', async () => {
    const client = await signInAs(STATE.memberBEmail)
    const { data: r1 } = await client.from('projects').select('id').eq('id', STATE.projectAOwnedByAdmin).maybeSingle()
    const { data: r2 } = await client.from('projects').select('id').eq('id', STATE.projectAMemberAdded).maybeSingle()
    expect(r1).toBeNull()
    expect(r2).toBeNull()
  })

  // ─── 4. get_user_project_role returns project_members role only ──
  it('get_user_project_role returns NULL for memberA on projectAOwnedByAdmin (no row, no fallback)', async () => {
    const { data, error } = await supabaseAdmin.rpc('get_user_project_role', {
      p_project_id: STATE.projectAOwnedByAdmin,
      p_user_id: STATE.memberAUserId,
    })
    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it('get_user_project_role returns "editor" for memberA on projectAMemberAdded', async () => {
    const { data, error } = await supabaseAdmin.rpc('get_user_project_role', {
      p_project_id: STATE.projectAMemberAdded,
      p_user_id: STATE.memberAUserId,
    })
    expect(error).toBeNull()
    expect(data).toBe('editor')
  })

  it('get_user_project_role returns "admin" for ownerA on projectAOwnedByAdmin (creator → admin)', async () => {
    const { data, error } = await supabaseAdmin.rpc('get_user_project_role', {
      p_project_id: STATE.projectAOwnedByAdmin,
      p_user_id: STATE.ownerAUserId,
    })
    expect(error).toBeNull()
    expect(data).toBe('admin')
  })

  // ─── 5. Stickiness ────────────────────────────────────────────────
  it('removing memberA from org_memberships does NOT remove their project_members row (stickiness)', async () => {
    // Snapshot the row first
    const { data: before } = await supabaseAdmin
      .from('project_members')
      .select('id, role')
      .eq('project_id', STATE.projectAMemberAdded)
      .eq('user_id', STATE.memberAUserId)
      .maybeSingle()
    expect(before?.role).toBe('editor')

    // Remove org membership directly (simulates an admin removing the
    // user from the org via a path that doesn't use the
    // `removeMember` Server Action — e.g. SQL editor cleanup, a
    // future SCIM provisioning path that hasn't yet been written, or
    // a manual SQL hotfix).
    await supabaseAdmin
      .from('org_memberships')
      .delete()
      .eq('org_id', STATE.orgA)
      .eq('user_id', STATE.memberAUserId)

    // Re-check: project_members row should still exist.
    const { data: after } = await supabaseAdmin
      .from('project_members')
      .select('id, role')
      .eq('project_id', STATE.projectAMemberAdded)
      .eq('user_id', STATE.memberAUserId)
      .maybeSingle()
    expect(after?.role).toBe('editor')

    // And memberA should still be able to SELECT the project (project_members
    // is the only gate; org_memberships was the legacy fallback, removed in 079).
    const client = await signInAs(STATE.memberAEmail)
    const { data: visible } = await client
      .from('projects')
      .select('id')
      .eq('id', STATE.projectAMemberAdded)
      .maybeSingle()
    expect(visible?.id).toBe(STATE.projectAMemberAdded)

    // Re-add the org membership so afterAll cleanup is symmetric and
    // the row count returns to baseline. This isn't strictly required
    // (afterAll cascades from organizations → org_memberships) but
    // makes "rerun the test on a stale state" more graceful.
    await supabaseAdmin
      .from('org_memberships')
      .insert({ org_id: STATE.orgA, user_id: STATE.memberAUserId, role: 'member' })
  })

  // ─── 6. Toggle semantics ──────────────────────────────────────────
  it('member_auto_grant_enabled OFF: new project does NOT auto-grant editor to org members', async () => {
    // The org-A toggle is OFF (set in beforeAll). Create a third project
    // and confirm memberA does NOT get an auto-grant row.
    const { data: p } = await supabaseAdmin
      .from('projects')
      .insert({
        name: `PRBAC Toggle-OFF ${stamp}`,
        org_id: STATE.orgA,
        user_id: STATE.ownerAUserId,
        created_by: STATE.ownerAUserId,
        use_mapping_redesign: true,
      })
      .select('id').single()

    await supabaseAdmin.rpc('grant_new_project_access', {
      p_project_id: p!.id,
      p_org_id: STATE.orgA,
      p_creator_id: STATE.ownerAUserId,
    })

    const { data: memberARow } = await supabaseAdmin
      .from('project_members')
      .select('id')
      .eq('project_id', p!.id)
      .eq('user_id', STATE.memberAUserId)
      .maybeSingle()
    expect(memberARow).toBeNull()

    // Owner A should still have admin (toggle only affects member auto-grant)
    const { data: ownerARow } = await supabaseAdmin
      .from('project_members')
      .select('role')
      .eq('project_id', p!.id)
      .eq('user_id', STATE.ownerAUserId)
      .maybeSingle()
    expect(ownerARow?.role).toBe('admin')

    // Cleanup this extra project
    await supabaseAdmin.from('projects').delete().eq('id', p!.id)
  })

  it('backfill_org_member_project_access RPC inserts editor rows for all members × projects in org', async () => {
    // Flip Org A toggle OFF→ON (it's currently OFF) and call the
    // backfill RPC. memberA was previously denied an auto-grant on
    // projectAOwnedByAdmin; backfill should now insert that row.
    await supabaseAdmin
      .from('organizations')
      .update({ member_auto_grant_enabled: true })
      .eq('id', STATE.orgA)
    const { error } = await supabaseAdmin.rpc('backfill_org_member_project_access', {
      p_org_id: STATE.orgA,
    })
    expect(error).toBeNull()

    const { data: row } = await supabaseAdmin
      .from('project_members')
      .select('role')
      .eq('project_id', STATE.projectAOwnedByAdmin)
      .eq('user_id', STATE.memberAUserId)
      .maybeSingle()
    expect(row?.role).toBe('editor')
  })
})
